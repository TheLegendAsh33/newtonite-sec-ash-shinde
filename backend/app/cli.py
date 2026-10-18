from __future__ import annotations

import argparse
from getpass import getpass

from sqlalchemy import select

from .database import make_database
from .models import Membership, Team, User
from .seed import seed_demo
from .security import hash_password


def bootstrap_admin(email: str, full_name: str, team_name: str) -> None:
    normalized_email = email.strip().lower()
    password = getpass("Initial administrator password (12+ characters): ")
    confirmation = getpass("Confirm password: ")
    if len(password) < 12:
        raise SystemExit("Password must be at least 12 characters.")
    if password != confirmation:
        raise SystemExit("Passwords do not match.")

    engine, factory = make_database()
    try:
        with factory.begin() as session:
            user = session.scalar(select(User).where(User.email == normalized_email))
            if user is None:
                user = User(full_name=full_name.strip(), email=normalized_email, password_hash=hash_password(password))
                session.add(user)
                session.flush()
            else:
                user.password_hash = hash_password(password)
            team = session.scalar(select(Team).where(Team.name == team_name.strip()))
            if team is None:
                team = Team(name=team_name.strip())
                session.add(team)
                session.flush()
            membership = session.scalar(select(Membership).where(Membership.team_id == team.id, Membership.user_id == user.id))
            if membership is None:
                session.add(Membership(team_id=team.id, user_id=user.id, role="admin"))
            else:
                membership.role = "admin"
    finally:
        engine.dispose()
    print(f"Administrator {normalized_email} is ready in team {team_name.strip()}.")


def add_member(email: str, full_name: str, team_name: str, role: str) -> None:
    normalized_email = email.strip().lower()
    engine, factory = make_database()
    try:
        with factory.begin() as session:
            team = session.scalar(select(Team).where(Team.name == team_name.strip()))
            if team is None:
                raise SystemExit(f"Team not found: {team_name}")
            user = session.scalar(select(User).where(User.email == normalized_email))
            if user is None:
                password = getpass("New user password (12+ characters): ")
                confirmation = getpass("Confirm password: ")
                if len(password) < 12:
                    raise SystemExit("Password must be at least 12 characters.")
                if password != confirmation:
                    raise SystemExit("Passwords do not match.")
                user = User(full_name=full_name.strip(), email=normalized_email, password_hash=hash_password(password))
                session.add(user)
                session.flush()
            membership = session.scalar(select(Membership).where(Membership.team_id == team.id, Membership.user_id == user.id))
            if membership is None:
                session.add(Membership(team_id=team.id, user_id=user.id, role=role))
            else:
                membership.role = role
    finally:
        engine.dispose()
    print(f"{normalized_email} now has the {role} role in team {team_name.strip()}.")


def seed_demo_accounts(*, reset_passwords: bool = False) -> None:
    engine, factory = make_database()
    try:
        with factory() as session:
            seed_demo(session, reset_passwords=reset_passwords)
    finally:
        engine.dispose()
    password_note = " Documented demo passwords were reset." if reset_passwords else " Existing passwords were preserved."
    print(f"Reviewer demo accounts, teams, and sample work are ready.{password_note}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Newtonite Workbench administration commands")
    commands = parser.add_subparsers(dest="command", required=True)
    bootstrap = commands.add_parser("bootstrap-admin", help="Create the first administrator and team")
    bootstrap.add_argument("--email", required=True)
    bootstrap.add_argument("--full-name", required=True)
    bootstrap.add_argument("--team", default="Operations")
    add = commands.add_parser("add-member", help="Create an account or assign an existing account to a team")
    add.add_argument("--email", required=True)
    add.add_argument("--full-name", required=True)
    add.add_argument("--team", required=True)
    add.add_argument("--role", choices=("member", "lead", "admin"), default="member")
    demo = commands.add_parser("seed-demo", help="Add the documented Newtonite reviewer accounts and sample workspace")
    demo.add_argument(
        "--reset-passwords",
        action="store_true",
        help="Set the documented demo passwords on existing demo accounts",
    )
    arguments = parser.parse_args()

    if arguments.command == "bootstrap-admin":
        bootstrap_admin(arguments.email, arguments.full_name, arguments.team)
    elif arguments.command == "add-member":
        add_member(arguments.email, arguments.full_name, arguments.team, arguments.role)
    elif arguments.command == "seed-demo":
        seed_demo_accounts(reset_passwords=arguments.reset_passwords)


if __name__ == "__main__":
    main()
