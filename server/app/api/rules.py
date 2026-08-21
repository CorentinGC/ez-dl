"""Routes CRUD `/api/rules` — règles de détection de flux vidéo par domaine."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session, select

from app.db import get_session
from app.models import SiteRule
from app.schemas import RuleCreate, RuleOut
from app.security import require_auth

router = APIRouter(tags=["rules"], dependencies=[Depends(require_auth)])


@router.get("/rules", response_model=list[RuleOut])
async def list_rules(session: Session = Depends(get_session)) -> list[SiteRule]:
    """Liste toutes les règles enregistrées, plus récentes en premier."""
    return list(session.exec(select(SiteRule).order_by(SiteRule.created_at.desc())).all())


@router.post("/rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleCreate, session: Session = Depends(get_session)) -> SiteRule:
    """Crée une nouvelle règle de détection."""
    rule = SiteRule(**body.model_dump(exclude={"source"}), source=body.source.value)
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return rule


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: int, session: Session = Depends(get_session)) -> Response:
    """Supprime une règle."""
    rule = session.get(SiteRule, rule_id)
    if rule is None:
        raise HTTPException(status_code=404, detail="Règle introuvable")
    session.delete(rule)
    session.commit()
    return Response(status_code=204)
