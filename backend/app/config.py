import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./campus_maintenance.db"
    jwt_secret: str = "local-development-secret-change-before-deployment"
    jwt_expire_minutes: int = 480
    cors_origins: str = "http://localhost:5173"
    environment: str = "development"
    upload_dir: Path = Path(__file__).resolve().parents[1] / "uploads"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


settings = Settings()

if settings.environment.lower() == "production" and settings.jwt_secret.startswith("local-development"):
    raise RuntimeError("Set JWT_SECRET to a unique secret before starting in production.")

