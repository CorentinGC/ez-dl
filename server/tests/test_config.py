"""Tests de `app.config` : validation au démarrage des réglages critiques."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import (
    APP_VERSION,
    Settings,
    conflicting_roots,
    ensure_password,
    parse_download_roots,
    read_app_version,
)


def test_blank_password_is_normalized_to_empty() -> None:
    """Une valeur d'espaces vaut « absent » : c'est le déclencheur de la génération auto."""
    assert Settings(password="   ", _env_file=None).password == ""


def test_ensure_password_generates_strong_password_when_missing() -> None:
    """Sans EZDL_PASSWORD, un mot de passe fort est généré et les réglages sont marqués
    pour que le démarrage l'affiche en console. Pas de mode sans authentification."""
    settings = ensure_password(Settings(password="", _env_file=None))

    assert settings.is_password_generated
    assert len(settings.password) >= 32

    other = ensure_password(Settings(password="", _env_file=None))
    assert other.password != settings.password


def test_ensure_password_keeps_user_password() -> None:
    """Un EZDL_PASSWORD fourni est conservé tel quel, sans marquage « généré »."""
    settings = ensure_password(Settings(password="mon-secret", _env_file=None))

    assert settings.password == "mon-secret"
    assert not settings.is_password_generated


@pytest.mark.parametrize(
    ("field", "env_name"),
    [("data_dir", "EZDL_DATA_DIR"), ("temp_dir", "EZDL_TEMP_DIR")],
)
def test_rejects_relative_dirs_with_actionable_message(field: str, env_name: str) -> None:
    """Un chemin relatif (ex : `./test`) produirait un PermissionError opaque en Docker :
    on doit échouer tôt en nommant la variable fautive et les valeurs attendues."""
    with pytest.raises(ValidationError, match=env_name) as exc_info:
        Settings(password="test-secret", _env_file=None, **{field: Path("./test")})

    assert "chemin absolu" in str(exc_info.value)


def test_accepts_absolute_dirs(tmp_path: Path) -> None:
    """Les chemins absolus (défauts Docker inclus) passent la validation."""
    settings = Settings(
        password="test-secret",
        data_dir=tmp_path / "data",
        temp_dir=tmp_path / "temp",
        _env_file=None,
    )

    assert settings.data_dir.is_absolute()
    assert settings.temp_dir.is_absolute()


def test_relative_dir_error_never_leaks_the_password() -> None:
    """Un validateur de MODÈLE joindrait le dict complet des réglages au message d'erreur,
    mot de passe compris — et ce message finit dans les logs de démarrage."""
    with pytest.raises(ValidationError) as exc_info:
        Settings(password="hunter2-secret", data_dir=Path("./rel"), _env_file=None)

    assert "hunter2-secret" not in str(exc_info.value)
    assert "hunter2" not in repr(exc_info.value)


@pytest.mark.parametrize(
    "raw",
    ["All=/", "Relative=media", "Trailing=./downloads"],
)
def test_rejects_dangerous_download_roots(raw: str) -> None:
    """Toute la sécurité des chemins repose sur l'appartenance à une racine : `/` rendrait
    le disque entier inscriptible et un chemin relatif dépendrait du cwd du process."""
    with pytest.raises(ValueError):
        parse_download_roots(raw)


def test_accepts_absolute_download_roots(tmp_path: Path) -> None:
    roots = parse_download_roots(f"Movies={tmp_path},Series={tmp_path / 'tv'}")

    assert [r.label for r in roots] == ["Movies", "Series"]
    assert roots[0].path == tmp_path


@pytest.mark.parametrize("field", ["data_dir", "extension_dist_dir"])
def test_reports_a_root_that_covers_the_server_state(tmp_path: Path, field: str) -> None:
    """Une racine qui contient la clé de signature ou le zip publié ferait d'un simple
    téléchargement une réécriture de l'extension distribuée, resignée par le serveur."""
    settings = Settings(
        password="x",
        download_roots=f"Media={tmp_path}",
        _env_file=None,
        **{field: tmp_path / "interne"},
    )

    assert conflicting_roots(settings)


def test_accepts_roots_disjoint_from_the_server_state(tmp_path: Path) -> None:
    settings = Settings(
        password="x",
        download_roots=f"Media={tmp_path / 'media'}",
        data_dir=tmp_path / "config",
        extension_dist_dir=tmp_path / "dist",
        _env_file=None,
    )

    assert conflicting_roots(settings) == []


@pytest.mark.parametrize("raw", ["ez-dl.example.com", "ftp://ez-dl.example.com", "//host"])
def test_rejects_a_public_url_without_an_http_scheme(raw: str) -> None:
    """`EZDL_PUBLIC_URL` est recopiée telle quelle dans `update.xml` : une base sans schéma
    produirait un manifeste que Chrome rejette sans rien expliquer."""
    with pytest.raises(ValidationError):
        Settings(password="x", public_url=raw, _env_file=None)


def test_strips_the_trailing_slash_of_the_public_url() -> None:
    settings = Settings(password="x", public_url="https://ez-dl.example.com/", _env_file=None)

    assert settings.public_url == "https://ez-dl.example.com"


def test_app_version_matches_pyproject() -> None:
    """Source de vérité unique : un numéro recopié à la main dériverait en silence."""
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    with pyproject.open("rb") as stream:
        assert APP_VERSION == tomllib.load(stream)["project"]["version"]


@pytest.mark.parametrize(
    "content",
    [
        "",
        "[project]\n",
        "[project]\nversion = 1\n",
        '[project]\nversion = ""\n',
        "pas du toml [",
    ],
)
def test_unreadable_pyproject_falls_back_instead_of_crashing(tmp_path: Path, content: str) -> None:
    """Un serveur qui affiche une version fausse vaut mieux qu'un serveur qui ne démarre pas."""
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(content, encoding="utf-8")

    assert read_app_version(pyproject) == "0.0.0"


def test_missing_pyproject_falls_back(tmp_path: Path) -> None:
    assert read_app_version(tmp_path / "absent.toml") == "0.0.0"
