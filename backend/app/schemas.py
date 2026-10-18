from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginInput(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class ItemCreate(StrictModel):
    team_id: str
    title: str = Field(min_length=3, max_length=180)
    purpose: str = Field(min_length=3, max_length=4000)
    priority: Literal["low", "medium", "high", "urgent"] = "medium"

    @field_validator("title", "purpose", mode="before")
    @classmethod
    def trim_text(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value


class ItemUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=3, max_length=180)
    purpose: str | None = Field(default=None, min_length=3, max_length=4000)
    status: Literal["open", "in_progress", "blocked", "in_review", "done"] | None = None
    priority: Literal["low", "medium", "high", "urgent"] | None = None
    owner_id: str | None = None

    @field_validator("title", "purpose", mode="before")
    @classmethod
    def trim_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("This field cannot be blank.")
        if not isinstance(value, str):
            return value
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be blank.")
        return value

    @field_validator("status", "priority")
    @classmethod
    def reject_null_fields(cls, value: str | None) -> str | None:
        if value is None:
            raise ValueError("This field cannot be blank.")
        return value


class ClaimInput(StrictModel):
    expected_version: int = Field(ge=1)


class CommentInput(StrictModel):
    content: str = Field(min_length=1, max_length=2000)

    @field_validator("content")
    @classmethod
    def trim_comment(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A comment cannot be blank.")
        return value
