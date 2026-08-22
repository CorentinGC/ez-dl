"""Tests du packing CRX3 : structure du conteneur, signature vérifiable, identifiant stable,
permissions de la clé privée et invalidation du cache."""

from __future__ import annotations

import hashlib
import os
import stat

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from app.core import crx

ARCHIVE = b"PK\x03\x04" + b"contenu-zip-factice" * 8


def _read_varint(payload: bytes, offset: int) -> tuple[int, int]:
    """Décode un varint protobuf à partir de `offset` ; retourne (valeur, offset suivant)."""
    value = 0
    shift = 0
    while True:
        byte = payload[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, offset
        shift += 7


def _parse_fields(payload: bytes) -> dict[int, list[bytes]]:
    """Parse un message protobuf composé uniquement de champs à longueur préfixée."""
    fields: dict[int, list[bytes]] = {}
    offset = 0
    while offset < len(payload):
        tag, offset = _read_varint(payload, offset)
        assert tag & 0x07 == 2, "seuls des champs de type 2 sont attendus"
        length, offset = _read_varint(payload, offset)
        fields.setdefault(tag >> 3, []).append(payload[offset : offset + length])
        offset += length
    return fields


def _split_crx(blob: bytes) -> tuple[bytes, bytes]:
    """Sépare l'en-tête protobuf de l'archive zip, en vérifiant magic et version."""
    assert blob[:4] == b"Cr24"
    assert int.from_bytes(blob[4:8], "little") == 3
    header_size = int.from_bytes(blob[8:12], "little")
    return blob[12 : 12 + header_size], blob[12 + header_size :]


@pytest.fixture(autouse=True)
def _clear_key_cache():
    """Vide la mémoïsation des clés entre deux tests (isolation des dossiers temporaires)."""
    crx._keys.clear()
    yield
    crx._keys.clear()


@pytest.fixture
def key(tmp_path):
    """Clé de signature persistée dans un dossier de données temporaire."""
    return crx.load_or_create_key(tmp_path / "data")


def test_pack_produces_parsable_crx3_container(key):
    header, archive = _split_crx(crx.pack(ARCHIVE, key))

    assert archive == ARCHIVE
    fields = _parse_fields(header)
    assert len(fields[2]) == 1, "une preuve sha256_with_rsa attendue"
    assert len(fields[10000]) == 1, "un signed_header_data attendu"


def test_signed_header_data_carries_the_crx_id(key):
    header, _ = _split_crx(crx.pack(ARCHIVE, key))
    signed_header_data = _parse_fields(header)[10000][0]

    crx_id = _parse_fields(signed_header_data)[1][0]
    assert crx_id == hashlib.sha256(crx.public_key_der(key)).digest()[:16]


def test_signature_verifies_against_the_embedded_public_key(key):
    blob = crx.pack(ARCHIVE, key)
    header, archive = _split_crx(blob)
    fields = _parse_fields(header)
    signed_header_data = fields[10000][0]
    proof = _parse_fields(fields[2][0])

    public_key = serialization.load_der_public_key(proof[1][0])
    signed_bytes = (
        b"CRX3 SignedData\x00"
        + len(signed_header_data).to_bytes(4, "little")
        + signed_header_data
        + archive
    )
    # Ne lève pas : la signature couvre bien le préfixe, l'en-tête signé et l'archive.
    public_key.verify(proof[2][0], signed_bytes, padding.PKCS1v15(), hashes.SHA256())


def test_signature_rejects_a_tampered_archive(key):
    blob = crx.pack(ARCHIVE, key)
    header, archive = _split_crx(blob)
    fields = _parse_fields(header)
    proof = _parse_fields(fields[2][0])
    public_key = serialization.load_der_public_key(proof[1][0])

    tampered = (
        b"CRX3 SignedData\x00"
        + len(fields[10000][0]).to_bytes(4, "little")
        + fields[10000][0]
        + archive
        + b"charge-utile-injectee"
    )
    with pytest.raises(InvalidSignature):
        public_key.verify(proof[2][0], tampered, padding.PKCS1v15(), hashes.SHA256())


def test_extension_id_is_32_chars_in_the_a_to_p_alphabet(key):
    identifier = crx.extension_id(crx.public_key_der(key))

    assert len(identifier) == 32
    assert all("a" <= char <= "p" for char in identifier)


def test_extension_id_is_stable_for_a_known_key():
    # Vecteur fixe : une clé publique de 4 octets suffit à figer la dérivation de l'identifiant.
    digest = hashlib.sha256(b"cle").digest()[:16]
    expected = "".join(
        chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0x0F)) for byte in digest
    )

    assert crx.extension_id(b"cle") == expected


def test_key_is_generated_once_and_readable_only_by_its_owner(tmp_path):
    key_dir = tmp_path / "data"
    first = crx.load_or_create_key(key_dir)
    # Mémoire de process vidée : la stabilité de l'identifiant doit tenir au fichier persisté,
    # pas au cache — c'est ce qui fait qu'un redémarrage publie une mise à jour et non une
    # extension différente.
    crx._keys.clear()
    second = crx.load_or_create_key(key_dir)

    key_path = key_dir / crx.KEY_FILENAME
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert crx.extension_id(crx.public_key_der(first)) == crx.extension_id(
        crx.public_key_der(second)
    )


def test_key_is_never_regenerated_within_a_process(tmp_path, monkeypatch):
    """Une clé RSA coûte ~50 ms : sur des routes publiques, la regénérer par requête serait
    une amplification CPU offerte à n'importe quel visiteur."""
    key_dir = tmp_path / "data"
    crx.load_or_create_key(key_dir)

    def _fail(*args, **kwargs):
        raise AssertionError("génération de clé inattendue : le cache de process n'a pas servi")

    monkeypatch.setattr(crx.rsa, "generate_private_key", _fail)
    assert crx.load_or_create_key(key_dir) is not None


def test_load_or_create_key_rejects_a_non_rsa_key(tmp_path):
    key_dir = tmp_path / "data"
    key_dir.mkdir()
    (key_dir / crx.KEY_FILENAME).write_text("pas une clé PEM")

    with pytest.raises(ValueError):
        crx.load_or_create_key(key_dir)


def test_build_signed_crx_reuses_the_cache_for_an_unchanged_zip(tmp_path):
    archive_path = tmp_path / "ez-dl-extension.zip"
    archive_path.write_bytes(ARCHIVE)
    cache_dir = tmp_path / "cache"
    key_dir = tmp_path / "data"

    built = crx.build_signed_crx(archive_path, cache_dir, key_dir)
    first_mtime = built.stat().st_mtime_ns

    assert crx.build_signed_crx(archive_path, cache_dir, key_dir).stat().st_mtime_ns == (
        first_mtime
    ), "un zip inchangé ne doit pas être resigné"


def test_build_signed_crx_rebuilds_on_content_even_when_the_mtime_does_not_move(tmp_path):
    archive_path = tmp_path / "ez-dl-extension.zip"
    archive_path.write_bytes(ARCHIVE)
    cache_dir = tmp_path / "cache"
    key_dir = tmp_path / "data"

    first = crx.build_signed_crx(archive_path, cache_dir, key_dir)
    stamps = archive_path.stat()

    # Zip republié avec un horodatage figé (build reproductible, restauration de sauvegarde) :
    # une invalidation basée sur le mtime servirait indéfiniment l'ancien artefact signé.
    archive_path.write_bytes(ARCHIVE + b"nouvelle-version")
    os.utime(archive_path, (stamps.st_atime, stamps.st_mtime))

    rebuilt = crx.build_signed_crx(archive_path, cache_dir, key_dir)
    _, archive = _split_crx(rebuilt.read_bytes())
    assert archive == ARCHIVE + b"nouvelle-version"
    assert rebuilt != first, "le cache est indexé sur le contenu de l'archive"


def test_build_signed_crx_drops_the_previous_artifact_from_the_cache(tmp_path):
    archive_path = tmp_path / "ez-dl-extension.zip"
    archive_path.write_bytes(ARCHIVE)
    cache_dir = tmp_path / "cache"
    key_dir = tmp_path / "data"

    crx.build_signed_crx(archive_path, cache_dir, key_dir)
    archive_path.write_bytes(ARCHIVE + b"nouvelle-version")
    current = crx.build_signed_crx(archive_path, cache_dir, key_dir)

    assert [path.name for path in cache_dir.glob("*.crx")] == [current.name]


def test_cache_filename_never_derives_from_the_published_version(tmp_path):
    """Le nom du `.crx` en cache vient du seul SHA-256 de l'archive : aucune valeur lue sur
    disque (version du build) ne peut atteindre un composant de chemin."""
    archive_path = tmp_path / "ez-dl-extension.zip"
    archive_path.write_bytes(ARCHIVE)

    built = crx.build_signed_crx(archive_path, tmp_path / "cache", tmp_path / "data")

    digest = hashlib.sha256(ARCHIVE).hexdigest()[:16]
    assert built.name == f"ez-dl-extension-{digest}.crx"


def test_signing_identity_matches_the_key_used_to_sign(tmp_path):
    key_dir = tmp_path / "data"
    signing_key = crx.load_or_create_key(key_dir)

    assert crx.signing_identity(key_dir) == crx.extension_id(crx.public_key_der(signing_key))
