from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import event

from app.main import create_app
from app.models import Activity, WorkItem
from .conftest import create_item, sign_in, support_team_id


def test_stale_version_is_rejected_and_latest_state_is_preserved(client: TestClient) -> None:
    sign_in(client, "jordan@newtonite.local", "Jordan2026!")
    item = create_item(client)

    first = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "status": "in_progress"})
    assert first.status_code == 200
    assert first.json()["version"] == 2

    stale = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "priority": "urgent"})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_version"
    assert client.get(f"/api/items/{item['id']}").json()["priority"] == "high"


def test_two_members_cannot_claim_the_same_item(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    item = create_item(client, title="Shared unassigned investigation")
    expected_version = item["version"]
    jordan_app = create_app(client.app.state.database_url, seed_data=False)
    casey_app = create_app(client.app.state.database_url, seed_data=False)
    with TestClient(jordan_app) as jordan, TestClient(casey_app) as casey:
        sign_in(jordan, "jordan@newtonite.local", "Jordan2026!")
        sign_in(casey, "casey@newtonite.local", "Casey2026!")

        def claim(as_client: TestClient):
            return as_client.post(f"/api/items/{item['id']}/claim", json={"expected_version": expected_version})

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, [jordan, casey]))

        assert sorted(result.status_code for result in results) == [200, 409]
        winner = next(result.json() for result in results if result.status_code == 200)
        loser = next(result for result in results if result.status_code == 409)
        assert winner["owner_id"] in {jordan.get("/api/auth/me").json()["user"]["id"], casey.get("/api/auth/me").json()["user"]["id"]}
        assert loser.json()["detail"]["code"] == "already_claimed"

    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    latest = client.get(f"/api/items/{item['id']}").json()
    assert latest["owner_id"] == winner["owner_id"]
    assert [event["event_type"] for event in latest["history"]].count("claimed") == 1


def test_invalid_workflow_transition_is_rejected(client: TestClient) -> None:
    sign_in(client, "jordan@newtonite.local", "Jordan2026!")
    item = create_item(client)

    response = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "status": "done"})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_transition"
    latest = client.get(f"/api/items/{item['id']}").json()
    assert latest["status"] == "open"
    assert latest["version"] == 1


def test_member_cannot_edit_another_owners_item_and_other_team_is_hidden(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    item = create_item(client)
    teams = client.get("/api/teams").json()
    payments_id = next(team["id"] for team in teams if team["name"] == "Payments")
    payments_item = create_item(client, team_id=payments_id, title="Private payments work")

    sign_in(client, "casey@newtonite.local", "Casey2026!")
    forbidden = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "priority": "urgent"})
    assert forbidden.status_code == 403
    hidden = client.get(f"/api/items/{payments_item['id']}")
    assert hidden.status_code == 404


def test_search_filters_and_pagination_are_applied_by_api(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    create_item(client, team_id=team_id, title="Needle in a support queue")
    create_item(client, team_id=team_id, title="Another support task")

    page = client.get("/api/items", params={"team_id": team_id, "q": "Needle", "page": 1, "page_size": 1})
    assert page.status_code == 200
    assert page.json()["total"] == 1
    assert len(page.json()["items"]) == 1
    assert page.json()["items"][0]["title"] == "Needle in a support queue"

    paged = client.get("/api/items", params={"team_id": team_id, "page": 1, "page_size": 1})
    assert paged.json()["total"] > 1
    assert len(paged.json()["items"]) == 1
    assert paged.json()["total_pages"] == paged.json()["total"]


def test_idempotency_key_replays_create_and_rejects_different_payload(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    key = uuid4().hex
    payload = {
        "team_id": team_id,
        "title": "Retry-safe work item",
        "purpose": "A repeated create request should return the original result.",
        "priority": "high",
    }

    created = client.post("/api/items", json=payload, headers={"Idempotency-Key": key})
    replay = client.post("/api/items", json=payload, headers={"Idempotency-Key": key})
    assert created.status_code == replay.status_code == 201
    assert created.json()["id"] == replay.json()["id"]

    mismatch = client.post("/api/items", json={**payload, "title": "Different content"}, headers={"Idempotency-Key": key})
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == "idempotency_key_reused"

    team_items = client.get("/api/items", params={"team_id": team_id, "q": payload["title"]})
    assert team_items.json()["total"] == 1


def test_simultaneous_create_retries_commit_one_item_and_one_event(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    payload = {"team_id": team_id, "title": "Simultaneous safe retry", "purpose": "Only one operation should commit."}
    key = uuid4().hex
    first_app = create_app(client.app.state.database_url, seed_data=False)
    retry_app = create_app(client.app.state.database_url, seed_data=False)
    with TestClient(first_app) as first, TestClient(retry_app) as retry:
        for as_client in (first, retry):
            sign_in(as_client, "morgan@newtonite.local", "Morgan2026!")

        def submit(as_client: TestClient):
            return as_client.post("/api/items", json=payload, headers={"Idempotency-Key": key})

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(submit, [first, retry]))
        assert [response.status_code for response in responses] == [201, 201]
        assert responses[0].json() == responses[1].json()
    items = client.get("/api/items", params={"team_id": team_id, "q": payload["title"]}).json()
    assert items["total"] == 1
    history = client.get(f"/api/items/{items['items'][0]['id']}").json()["history"]
    assert len(history) == 1
    assert history[0]["event_type"] == "created"


def test_stale_noop_and_transition_return_conflict_before_validation(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    item = create_item(client)
    changed = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "status": "in_progress"})
    assert changed.status_code == 200

    # The same current priority must not make an old form appear successfully saved.
    noop = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "priority": "high"})
    assert noop.status_code == 409
    assert noop.json()["detail"]["current_version"] == 2
    stale_transition = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "status": "open"})
    assert stale_transition.status_code == 409
    assert stale_transition.json()["detail"]["code"] == "stale_version"
    latest = client.get(f"/api/items/{item['id']}").json()
    assert latest["version"] == 2
    assert len(latest["history"]) == 2


def test_history_cursor_recovers_all_events_without_duplicates(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    item = create_item(client)
    actor_id = client.get("/api/auth/me").json()["user"]["id"]
    # Identical timestamps exercise the id tiebreaker, including the page boundary.
    timestamp = datetime(2020, 1, 1, tzinfo=timezone.utc)
    with client.app.state.session_factory() as session:
        session.add_all([
            Activity(item_id=item["id"], actor_id=actor_id, event_type="comment", details={"content": f"Historical note {number}"}, created_at=timestamp)
            for number in range(120)
        ])
        session.commit()
    detail = client.get(f"/api/items/{item['id']}").json()
    assert len(detail["history"]) == 100
    assert detail["history_has_more"] is True
    events = detail["history"]
    cursor = detail["history_next_cursor"]

    # A new event between page requests must not shift the older-event boundary.
    assert client.post(f"/api/items/{item['id']}/comments", json={"content": "New while paging"}).status_code == 201
    while cursor:
        response = client.get(f"/api/items/{item['id']}/history", params={"before": cursor, "page_size": 7})
        assert response.status_code == 200
        page = response.json()
        assert len(page["events"]) <= 7
        events += page["events"]
        cursor = page["next_cursor"]
    assert len(events) == len({event["id"] for event in events}) == 121
    assert all(event["details"].get("content") != "New while paging" for event in events)


def test_history_is_team_scoped_and_rejects_invalid_cursors_and_page_sizes(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    item = create_item(client)
    other = create_item(client, title="Different history")
    other_event = client.get(f"/api/items/{other['id']}").json()["history"][0]["id"]
    assert client.get(f"/api/items/{item['id']}/history", params={"before": other_event}).status_code == 422
    for page_size in (0, 101):
        assert client.get(f"/api/items/{item['id']}/history", params={"page_size": page_size}).status_code == 422
    sign_in(client, "taylor@newtonite.local", "Taylor2026!")
    assert client.get(f"/api/items/{item['id']}/history").status_code == 404
    client.post("/api/auth/logout")
    assert client.get(f"/api/items/{item['id']}/history").status_code == 401


def test_search_treats_wildcards_as_literal_text(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    percent = create_item(client, title="Investigate 50% payout gap")
    underscore = create_item(client, title="Investigate customer_record mismatch")
    for query, expected in (("%", percent), ("_", underscore)):
        results = client.get("/api/items", params={"team_id": team_id, "q": query}).json()
        assert results["total"] == 1
        assert results["items"][0]["id"] == expected["id"]


def test_trimmed_text_must_meet_length_and_type_constraints(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    item = create_item(client)
    for invalid in (" a ", 123, None):
        response = client.post("/api/items", headers={"Idempotency-Key": uuid4().hex}, json={
            "team_id": team_id, "title": invalid, "purpose": "Valid context",
        })
        assert response.status_code == 422
        update = client.patch(f"/api/items/{item['id']}", json={"expected_version": 1, "title": invalid})
        assert update.status_code == 422
    assert client.get(f"/api/items/{item['id']}").json()["version"] == 1


def test_queue_serialization_batches_people_in_one_query(client: TestClient) -> None:
    sign_in(client, "morgan@newtonite.local", "Morgan2026!")
    team_id = support_team_id(client)
    with client.app.state.session_factory() as session:
        actor_id = client.get("/api/auth/me").json()["user"]["id"]
        session.add_all([
            WorkItem(team_id=team_id, title=f"Queue item {number}", purpose="Batch serialization check", created_by=actor_id)
            for number in range(30)
        ])
        session.commit()
    statements = []

    def record_statement(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(client.app.state.engine, "before_cursor_execute", record_statement)
    try:
        response = client.get("/api/items", params={"team_id": team_id, "page_size": 50})
    finally:
        event.remove(client.app.state.engine, "before_cursor_execute", record_statement)
    assert response.status_code == 200
    assert len(response.json()["items"]) >= 30
    # Authentication, membership, count, queue and one people batch, independent of row count.
    assert len(statements) <= 5
