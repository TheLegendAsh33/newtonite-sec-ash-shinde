from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Membership, Team, User, WorkItem, Activity
from .security import hash_password


DEMO_USERS = [
    ("Morgan Chen", "morgan@newtonite.local", "Morgan2026!"),
    ("Jordan Patel", "jordan@newtonite.local", "Jordan2026!"),
    ("Casey Rivera", "casey@newtonite.local", "Casey2026!"),
    ("Taylor Brooks", "taylor@newtonite.local", "Taylor2026!"),
]


def seed_demo(session: Session, *, reset_passwords: bool = False) -> None:
    """Add the reviewer workspace without deleting or replacing unrelated data.

    Existing account passwords are left alone unless ``reset_passwords`` is
    explicitly requested. Teams, memberships, sample work and activity are
    created only when missing, so the command is safe to repeat.
    """
    users: list[User] = []
    for name, email, password in DEMO_USERS:
        user = session.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(full_name=name, email=email, password_hash=hash_password(password))
            session.add(user)
            session.flush()
        elif reset_passwords:
            user.password_hash = hash_password(password)
        users.append(user)

    support = session.scalar(select(Team).where(Team.name == "Support Operations"))
    if support is None:
        support = Team(name="Support Operations")
        session.add(support)
        session.flush()

    payments = session.scalar(select(Team).where(Team.name == "Payments"))
    if payments is None:
        payments = Team(name="Payments")
        session.add(payments)
        session.flush()

    expected_memberships = [
        (support, users[0], "admin"),
        (support, users[1], "lead"),
        (support, users[2], "member"),
        (payments, users[0], "lead"),
        (payments, users[3], "member"),
    ]
    for team, user, role in expected_memberships:
        membership = session.scalar(
            select(Membership).where(Membership.team_id == team.id, Membership.user_id == user.id)
        )
        if membership is None:
            session.add(Membership(team_id=team.id, user_id=user.id, role=role))
        else:
            membership.role = role

    examples = [
        (support, "Refund review for order #88421", "Confirm the duplicate charge and coordinate a customer refund.", "in_progress", "urgent", users[1]),
        (support, "Update account recovery checklist", "Review the support checklist after the latest identity flow change.", "open", "medium", None),
        (support, "Investigate delayed payout batch", "Find the source of the 14:00 payout delay and report the impact.", "blocked", "high", users[2]),
        (support, "Document chargeback handoff", "Capture the handoff steps between support and payments.", "in_review", "low", users[1]),
        (payments, "Reconcile missing settlement", "Compare settlement totals against the bank report and identify the missing transfer.", "open", "high", None),
    ]
    for team, title, purpose, status, priority, owner in examples:
        item = session.scalar(
            select(WorkItem).where(WorkItem.team_id == team.id, WorkItem.title == title)
        )
        if item is not None:
            continue
        item = WorkItem(
            team_id=team.id,
            title=title,
            purpose=purpose,
            status=status,
            priority=priority,
            owner_id=owner.id if owner else None,
            created_by=users[0].id,
        )
        session.add(item)
        session.flush()
        session.add(
            Activity(item_id=item.id, actor_id=users[0].id, event_type="created", details={"title": title})
        )

    session.commit()
