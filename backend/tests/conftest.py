import pytest
from fastapi.testclient import TestClient
from pathlib import Path
from uuid import uuid4

from app.database import make_database
from app.main import create_app
from app.models import Base


@pytest.fixture
def client():
    test_root = Path(__file__).resolve().parents[1] / ".pytest-tmp"
    test_root.mkdir(exist_ok=True)
    db_path = test_root / f"workbench-{uuid4().hex}.db"
    database_url = f"sqlite:///{db_path.as_posix()}"
    engine, _ = make_database(database_url)
    Base.metadata.create_all(engine)
    engine.dispose()
    app = create_app(database_url)
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        db_path.unlink(missing_ok=True)


def sign_in(client: TestClient, email: str, password: str) -> None:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text


def support_team_id(client: TestClient) -> str:
    teams = client.get("/api/teams").json()
    return next(team["id"] for team in teams if team["name"] == "Support Operations")


def create_item(client: TestClient, *, team_id: str | None = None, title: str = "Review customer refund") -> dict:
    if team_id is None:
        team_id = support_team_id(client)
    response = client.post("/api/items", json={
        "team_id": team_id,
        "title": title,
        "purpose": "Verify the request and coordinate the next action.",
        "priority": "high",
    }, headers={"Idempotency-Key": uuid4().hex})
    assert response.status_code == 201, response.text
    return response.json()
