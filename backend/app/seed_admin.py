import getpass

from sqlalchemy import select

from app.database import SessionLocal
from app.models import User
from app.security import hash_password


def main():
    email = input("Administrator email: ").strip().lower()
    name = input("Administrator name: ").strip()
    password = getpass.getpass("Administrator password (10+ characters): ")
    if "@" not in email or len(password) < 10:
        raise SystemExit("A valid email and a password of at least 10 characters are required.")
    with SessionLocal() as db:
        if db.scalar(select(User.id).where(User.email == email)):
            raise SystemExit("That email already has an account.")
        db.add(User(name=name, email=email, password_hash=hash_password(password), role="administrator"))
        db.commit()
    print("Administrator account created.")


if __name__ == "__main__":
    main()
