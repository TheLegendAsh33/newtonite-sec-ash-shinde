from __future__ import annotations

import os
import hashlib
import json
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, case, func, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware
from uuid import uuid4

from .database import get_db, make_database
from .logging_config import configure_request_logger
from .models import Activity, IdempotencyRecord, Membership, Team, User, WorkItem, now_utc
from .schemas import ClaimInput, CommentInput, ItemCreate, ItemUpdate, LoginInput
from .seed import seed_demo
from .security import verify_password


WORKFLOW = {
    "open": {"in_progress"},
    "in_progress": {"blocked", "in_review", "done"},
    "blocked": {"in_progress"},
    "in_review": {"in_progress", "done"},
    "done": set(),
}
ELEVATED_ROLES = {"lead", "admin"}


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def user_payload(user: User) -> dict[str, str]:
    return {"id": user.id, "full_name": user.full_name, "email": user.email}


def membership_for(db: Session, team_id: str, user_id: str) -> Membership | None:
    return db.scalar(select(Membership).where(Membership.team_id == team_id, Membership.user_id == user_id))


def require_team_role(db: Session, team_id: str, user: User) -> Membership:
    membership = membership_for(db, team_id, user.id)
    if membership is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Team not found."})
    return membership


def require_item(db: Session, item_id: str, user: User) -> tuple[WorkItem, Membership]:
    item = db.get(WorkItem, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Work item not found."})
    membership = membership_for(db, item.team_id, user.id)
    if membership is None:
        # Do not disclose that a work item exists in another team's queue.
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Work item not found."})
    return item, membership


def activity_page(db: Session, item_id: str, *, before: str | None = None, page_size: int = 25) -> dict[str, Any]:
    query = (
        select(Activity, User.full_name)
        .join(User, Activity.actor_id == User.id)
        .where(Activity.item_id == item_id)
    )
    if before is not None:
        cursor = db.scalar(select(Activity).where(Activity.id == before, Activity.item_id == item_id))
        if cursor is None:
            raise HTTPException(status_code=422, detail={"code": "invalid_cursor", "message": "The history cursor does not belong to this work item."})
        query = query.where(or_(
            Activity.created_at < cursor.created_at,
            and_(Activity.created_at == cursor.created_at, Activity.id < cursor.id),
        ))
    rows = db.execute(query.order_by(Activity.created_at.desc(), Activity.id.desc()).limit(page_size + 1)).all()
    has_more = len(rows) > page_size
    events = [
        {
            "id": event.id,
            "event_type": event.event_type,
            "details": event.details,
            "actor_name": actor_name,
            "created_at": iso(event.created_at),
        }
        for event, actor_name in rows[:page_size]
    ]
    return {"events": events, "next_cursor": events[-1]["id"] if has_more else None, "has_more": has_more}


def item_payload(item: WorkItem, db: Session, *, with_history: bool = False, users: dict[str, User] | None = None) -> dict[str, Any]:
    owner = (users.get(item.owner_id) if users is not None else db.get(User, item.owner_id)) if item.owner_id else None
    creator = users.get(item.created_by) if users is not None else db.get(User, item.created_by)
    payload: dict[str, Any] = {
        "id": item.id,
        "team_id": item.team_id,
        "title": item.title,
        "purpose": item.purpose,
        "status": item.status,
        "priority": item.priority,
        "owner_id": item.owner_id,
        "owner": user_payload(owner) if owner else None,
        "created_by": user_payload(creator) if creator else None,
        "version": item.version,
        "created_at": iso(item.created_at),
        "updated_at": iso(item.updated_at),
    }
    if with_history:
        history = activity_page(db, item.id, page_size=100)
        payload["history"] = history["events"]
        payload["history_next_cursor"] = history["next_cursor"]
        payload["history_has_more"] = history["has_more"]
    return payload


def add_activity(db: Session, item_id: str, actor_id: str, event_type: str, details: dict[str, Any]) -> None:
    db.add(Activity(item_id=item_id, actor_id=actor_id, event_type=event_type, details=details))


def conflict_detail(db: Session, item_id: str, code: str = "stale_version") -> dict[str, Any]:
    current = db.get(WorkItem, item_id)
    return {
        "code": code,
        "message": "Someone else changed this item. Review the latest version and try again.",
        "current_version": current.version if current else None,
    }


def create_app(database_url: str | None = None, *, seed_data: bool | None = None) -> FastAPI:
    request_logger = configure_request_logger()
    app_env = os.getenv("APP_ENV", "development").lower()
    configured_database_url = database_url or os.getenv("DATABASE_URL", "sqlite:///./newtonite.db")
    if app_env == "production" and not configured_database_url.startswith("postgresql+psycopg://"):
        raise RuntimeError("Production requires DATABASE_URL to use PostgreSQL with psycopg.")
    if seed_data is None:
        seed_data = os.getenv("SEED_DEMO_DATA", "true" if app_env == "development" else "false").lower() == "true"
    session_secret = os.getenv("SESSION_SECRET")
    if not session_secret:
        if app_env == "production":
            raise RuntimeError("SESSION_SECRET must be set when APP_ENV=production.")
        session_secret = "development-only-secret-change-before-deployment"
    if app_env == "production":
        if len(session_secret) < 64 or "CHANGE_ME" in session_secret:
            raise RuntimeError("SESSION_SECRET must be a unique random value of at least 64 characters in production.")
        public_host = os.getenv("PUBLIC_HOST", ":8080")
        cookie_https_only = os.getenv("COOKIE_HTTPS_ONLY", "false").lower() == "true"
        if public_host == ":8080" and cookie_https_only:
            raise RuntimeError("COOKIE_HTTPS_ONLY must be false for the local HTTP :8080 profile.")
        if public_host != ":8080" and not cookie_https_only:
            raise RuntimeError("COOKIE_HTTPS_ONLY must be true when PUBLIC_HOST is a public hostname.")
        if "CHANGE_ME" in configured_database_url:
            raise RuntimeError("Replace the example database credentials before starting production.")
        redis_url = os.getenv("REDIS_URL")
        if not redis_url:
            raise RuntimeError("REDIS_URL must be set when APP_ENV=production.")
        if "CHANGE_ME" in redis_url:
            raise RuntimeError("Replace the example Redis credentials before starting production.")
    else:
        redis_url = None
    engine, session_factory = make_database(configured_database_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            if app.state.redis is not None:
                app.state.redis.ping()
            if seed_data:
                with session_factory() as session:
                    seed_demo(session)
            yield
        finally:
            if app.state.redis is not None:
                app.state.redis.close()
            engine.dispose()

    production = app_env == "production"
    application = FastAPI(
        title="Newtonite Workbench API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None if production else "/docs",
        redoc_url=None if production else "/redoc",
        openapi_url=None if production else "/openapi.json",
    )
    application.state.session_factory = session_factory
    application.state.engine = engine
    application.state.database_url = str(engine.url)
    application.add_middleware(
        SessionMiddleware,
        secret_key=session_secret,
        session_cookie="newtonite_session",
        same_site="lax",
        https_only=os.getenv("COOKIE_HTTPS_ONLY", "false").lower() == "true",
        max_age=60 * 60 * 12,
    )
    if app_env == "production":
        import redis

        application.state.redis = redis.Redis.from_url(redis_url, socket_connect_timeout=3, socket_timeout=3)
    else:
        application.state.redis = None

    @application.middleware("http")
    async def security_headers(request: Request, call_next):
        request_id = uuid4().hex
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            request_logger.exception(
                "request failed",
                extra={"request_id": request_id, "method": request.method, "path": request.url.path},
            )
            raise
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if os.getenv("COOKIE_HTTPS_ONLY", "false").lower() == "true":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        request_logger.info(
            "request completed",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            },
        )
        return response

    origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type", "Idempotency-Key"],
    )

    def authenticated_user(request: Request, db: Session = Depends(get_db)) -> User:
        user_id = request.session.get("user_id")
        user = db.get(User, user_id) if user_id else None
        if user is None:
            raise HTTPException(status_code=401, detail={"code": "unauthenticated", "message": "Sign in to continue."})
        return user

    @application.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/health/live")
    def live() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/api/health/ready")
    def ready() -> dict[str, str]:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        if application.state.redis is not None:
            application.state.redis.ping()
        return {"status": "ready"}

    @application.post("/api/auth/login")
    def login(payload: LoginInput, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
        email = payload.email.strip().lower()
        limiter = request.app.state.redis
        if limiter is not None:
            client_ip = request.client.host if request.client else "unknown"
            key = f"auth:login:{client_ip}"
            attempts = int(limiter.eval(
                "local n=redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
                1,
                key,
                300,
            ))
            if attempts > 10:
                raise HTTPException(status_code=429, detail={"code": "rate_limited", "message": "Too many sign-in attempts. Try again in five minutes."}, headers={"Retry-After": "300"})
        user = db.scalar(select(User).where(User.email == email))
        if user is None or not verify_password(payload.password, user.password_hash):
            raise HTTPException(status_code=401, detail={"code": "invalid_credentials", "message": "Email or password is incorrect."})
        if limiter is not None:
            limiter.delete(f"auth:login:{request.client.host if request.client else 'unknown'}")
        request.session.clear()
        request.session["user_id"] = user.id
        return {"user": user_payload(user)}

    @application.get("/api/auth/me")
    def me(user: User = Depends(authenticated_user)) -> dict[str, Any]:
        return {"user": user_payload(user)}

    @application.post("/api/auth/logout", status_code=204)
    def logout(request: Request) -> Response:
        request.session.clear()
        return Response(status_code=204)

    @application.get("/api/teams")
    def list_teams(user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
        rows = db.execute(
            select(Team, Membership.role)
            .join(Membership, Membership.team_id == Team.id)
            .where(Membership.user_id == user.id)
            .order_by(Team.name)
        ).all()
        teams: list[dict[str, Any]] = []
        for team, role in rows:
            members = db.execute(
                select(User.id, User.full_name, User.email, Membership.role)
                .join(Membership, Membership.user_id == User.id)
                .where(Membership.team_id == team.id)
                .order_by(User.full_name)
            ).all()
            teams.append({
                "id": team.id,
                "name": team.name,
                "role": role,
                "members": [{"id": uid, "full_name": name, "email": email, "role": member_role} for uid, name, email, member_role in members],
            })
        return teams

    @application.get("/api/teams/{team_id}/summary")
    def team_summary(team_id: str, user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        require_team_role(db, team_id, user)
        counts = db.execute(
            select(
                func.count(WorkItem.id),
                func.sum(case((WorkItem.priority == "urgent", 1), else_=0)),
                func.sum(case((WorkItem.status == "blocked", 1), else_=0)),
                func.sum(case(((WorkItem.owner_id.is_(None)) & (WorkItem.status != "done"), 1), else_=0)),
            ).where(WorkItem.team_id == team_id, WorkItem.status != "done")
        ).one()
        status_counts = {status: 0 for status in WORKFLOW}
        for status, count in db.execute(
            select(WorkItem.status, func.count(WorkItem.id))
            .where(WorkItem.team_id == team_id)
            .group_by(WorkItem.status)
        ):
            if status in status_counts:
                status_counts[status] = count
        return {
            "active": counts[0] or 0,
            "urgent": counts[1] or 0,
            "blocked": counts[2] or 0,
            "unassigned": counts[3] or 0,
            "status_counts": status_counts,
        }

    @application.post("/api/items", status_code=201)
    def create_item(
        payload: ItemCreate,
        idempotency_key: str = Header(alias="Idempotency-Key", min_length=1, max_length=255),
        user: User = Depends(authenticated_user),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        require_team_role(db, payload.team_id, user)
        idempotency_key = idempotency_key.strip()
        if not idempotency_key:
            raise HTTPException(status_code=422, detail={"code": "invalid_idempotency_key", "message": "Idempotency-Key cannot be blank."})
        canonical_payload = json.dumps(payload.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        request_hash = hashlib.sha256(canonical_payload.encode("utf-8")).hexdigest()

        existing = db.scalar(
            select(IdempotencyRecord).where(
                IdempotencyRecord.user_id == user.id,
                IdempotencyRecord.idempotency_key == idempotency_key,
            )
        )
        if existing is not None:
            if existing.request_hash != request_hash:
                raise HTTPException(status_code=409, detail={"code": "idempotency_key_reused", "message": "This Idempotency-Key was already used for a different request."})
            return existing.response_body

        item = WorkItem(
            team_id=payload.team_id,
            title=payload.title,
            purpose=payload.purpose,
            priority=payload.priority,
            created_by=user.id,
        )
        db.add(item)
        db.flush()
        add_activity(db, item.id, user.id, "created", {"title": item.title, "status": item.status, "priority": item.priority})
        response_body = item_payload(item, db)
        db.add(IdempotencyRecord(
            user_id=user.id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            response_body=response_body,
        ))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.scalar(
                select(IdempotencyRecord).where(
                    IdempotencyRecord.user_id == user.id,
                    IdempotencyRecord.idempotency_key == idempotency_key,
                )
            )
            if existing is None:
                raise
            if existing.request_hash != request_hash:
                raise HTTPException(status_code=409, detail={"code": "idempotency_key_reused", "message": "This Idempotency-Key was already used for a different request."})
            return existing.response_body
        return response_body

    @application.get("/api/items")
    def list_items(
        team_id: str,
        q: str | None = Query(default=None, max_length=120),
        status: str | None = Query(default=None),
        priority: str | None = Query(default=None),
        owner: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=12, ge=1, le=50),
        user: User = Depends(authenticated_user),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        require_team_role(db, team_id, user)
        query = select(WorkItem).where(WorkItem.team_id == team_id)
        if q and q.strip():
            # User search text is literal: '%' and '_' must not match an entire queue.
            query = query.where((WorkItem.title.icontains(q.strip(), autoescape=True)) | (WorkItem.purpose.icontains(q.strip(), autoescape=True)))
        if status:
            if status not in WORKFLOW:
                raise HTTPException(status_code=422, detail={"code": "invalid_filter", "message": "Unknown status filter."})
            query = query.where(WorkItem.status == status)
        if priority:
            if priority not in {"low", "medium", "high", "urgent"}:
                raise HTTPException(status_code=422, detail={"code": "invalid_filter", "message": "Unknown priority filter."})
            query = query.where(WorkItem.priority == priority)
        if owner == "mine":
            query = query.where(WorkItem.owner_id == user.id)
        elif owner == "unassigned":
            query = query.where(WorkItem.owner_id.is_(None))
        elif owner:
            query = query.where(WorkItem.owner_id == owner)

        total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
        items = db.scalars(query.order_by(WorkItem.updated_at.desc(), WorkItem.id).offset((page - 1) * page_size).limit(page_size)).all()
        user_ids = {uid for item in items for uid in (item.owner_id, item.created_by) if uid}
        users = {member.id: member for member in db.scalars(select(User).where(User.id.in_(user_ids)))} if user_ids else {}
        return {
            "items": [item_payload(item, db, users=users) for item in items],
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": (total + page_size - 1) // page_size,
        }

    @application.get("/api/items/{item_id}")
    def get_item(item_id: str, user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        item, _ = require_item(db, item_id, user)
        return item_payload(item, db, with_history=True)

    @application.get("/api/items/{item_id}/history")
    def item_history(
        item_id: str,
        before: str | None = Query(default=None, min_length=1, max_length=36),
        page_size: int = Query(default=25, ge=1, le=100),
        user: User = Depends(authenticated_user),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        item, _ = require_item(db, item_id, user)
        return activity_page(db, item.id, before=before, page_size=page_size)

    @application.patch("/api/items/{item_id}")
    def update_item(item_id: str, payload: ItemUpdate, user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        item, membership = require_item(db, item_id, user)
        if membership.role not in ELEVATED_ROLES and item.owner_id != user.id:
            raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Only the owner or a team lead can update this item."})

        changes = payload.model_dump(exclude_unset=True)
        expected_version = changes.pop("expected_version")
        # Check even for a no-op or a transition that only became invalid after a
        # concurrent edit, so the client consistently reconciles stale forms.
        if expected_version != item.version:
            raise HTTPException(status_code=409, detail=conflict_detail(db, item_id))
        if not changes:
            raise HTTPException(status_code=422, detail={"code": "empty_update", "message": "Choose at least one field to update."})
        if "owner_id" in changes and membership.role not in ELEVATED_ROLES:
            raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "Only a team lead can reassign work. Use Claim work to take an unassigned item."})
        if "owner_id" in changes and changes["owner_id"] is not None:
            if membership_for(db, item.team_id, changes["owner_id"]) is None:
                raise HTTPException(status_code=422, detail={"code": "invalid_owner", "message": "The owner must be a member of this team."})
        if "status" in changes and changes["status"] != item.status and changes["status"] not in WORKFLOW[item.status]:
            raise HTTPException(status_code=422, detail={
                "code": "invalid_transition",
                "message": f"A work item cannot move from {item.status.replace('_', ' ')} to {changes['status'].replace('_', ' ')}.",
            })

        before: dict[str, Any] = {}
        readable_changes: dict[str, dict[str, Any]] = {}
        for field, new_value in changes.items():
            old_value = getattr(item, field)
            if old_value == new_value:
                continue
            before[field] = new_value
            if field == "owner_id":
                old_owner = db.get(User, old_value) if old_value else None
                new_owner = db.get(User, new_value) if new_value else None
                readable_changes[field] = {"from": old_owner.full_name if old_owner else "Unassigned", "to": new_owner.full_name if new_owner else "Unassigned"}
            else:
                readable_changes[field] = {"from": old_value, "to": new_value}
        if not before:
            return item_payload(item, db)

        result = db.execute(
            update(WorkItem)
            .where(WorkItem.id == item.id, WorkItem.team_id == item.team_id, WorkItem.version == expected_version)
            .values(**before, version=WorkItem.version + 1, updated_at=now_utc())
        )
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(status_code=409, detail=conflict_detail(db, item_id))
        add_activity(db, item.id, user.id, "updated", {"changes": readable_changes})
        db.commit()
        db.refresh(item)
        return item_payload(item, db)

    @application.post("/api/items/{item_id}/claim")
    def claim_item(item_id: str, payload: ClaimInput, user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        item, _ = require_item(db, item_id, user)
        if item.status == "done":
            raise HTTPException(status_code=422, detail={"code": "closed_item", "message": "Completed work cannot be claimed."})
        result = db.execute(
            update(WorkItem)
            .where(
                WorkItem.id == item.id,
                WorkItem.team_id == item.team_id,
                WorkItem.owner_id.is_(None),
                WorkItem.version == payload.expected_version,
            )
            .values(owner_id=user.id, version=WorkItem.version + 1, updated_at=now_utc())
        )
        if result.rowcount != 1:
            db.rollback()
            latest = db.get(WorkItem, item_id)
            if latest and latest.owner_id:
                owner = db.get(User, latest.owner_id)
                detail = {"code": "already_claimed", "message": f"This item was claimed by {owner.full_name if owner else 'another teammate'}.", "current_version": latest.version}
            else:
                detail = conflict_detail(db, item_id)
            raise HTTPException(status_code=409, detail=detail)
        add_activity(db, item.id, user.id, "claimed", {"owner": user.full_name})
        db.commit()
        db.refresh(item)
        return item_payload(item, db)

    @application.post("/api/items/{item_id}/comments", status_code=201)
    def comment_item(item_id: str, payload: CommentInput, user: User = Depends(authenticated_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        item, _ = require_item(db, item_id, user)
        add_activity(db, item.id, user.id, "comment", {"content": payload.content})
        db.execute(update(WorkItem).where(WorkItem.id == item.id).values(updated_at=now_utc()))
        db.commit()
        return {"ok": True}

    return application


app = create_app()
