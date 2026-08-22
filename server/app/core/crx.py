"""Empaquetage CRX3 : transforme le zip de l'extension produit au build en archive `.crx`
signée, installable par glisser-déposer dans `chrome://extensions`.

Format décrit par `components/crx_file/crx3.proto` (Chromium) :
`"Cr24"` + version (4 octets, little-endian) + taille de l'en-tête (4 octets, little-endian)
+ en-tête protobuf `CrxFileHeader` + archive zip. Les preuves `sha256_with_rsa` portent sur
`"CRX3 SignedData\\x00"` + taille + `signed_header_data` + archive, en RSA PKCS#1 v1.5 SHA-256
(`crx_verifier.cc`). Seuls trois champs protobuf sont nécessaires : ils sont encodés à la main,
ce qui évite une dépendance à `protobuf` et son compilateur.
"""

from __future__ import annotations

import hashlib
import os
import threading
import uuid
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

CRX_MAGIC = b"Cr24"
CRX_FORMAT_VERSION = 3

# `kSignatureContext` de crx_verifier.cc : préfixe des octets effectivement signés.
_SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"

# Numéros de champ protobuf (CrxFileHeader, AsymmetricKeyProof, SignedData).
_FIELD_SHA256_WITH_RSA = 2
_FIELD_SIGNED_HEADER_DATA = 10000
_FIELD_PUBLIC_KEY = 1
_FIELD_SIGNATURE = 2
_FIELD_CRX_ID = 1

# L'identifiant Chrome tient sur les 16 premiers octets du SHA-256 de la clé publique.
_CRX_ID_BYTES = 16
_KEY_SIZE_BITS = 2048

KEY_FILENAME = "extension-signing-key.pem"

# Préfixe des `.crx` en cache. Le nom est entièrement dérivé du contenu de l'archive : aucune
# valeur lue sur disque (version du build) n'entre dans un chemin.
_CACHE_PREFIX = "ez-dl-extension"
_CACHE_DIGEST_CHARS = 16

# Clés déjà chargées, par chemin. Générer une clé RSA coûte ~50 ms : sans mémoïsation, un
# dossier de données non inscriptible ferait regénérer une clé à CHAQUE requête publique.
_keys: dict[Path, rsa.RSAPrivateKey] = {}
_keys_lock = threading.Lock()


def _varint(value: int) -> bytes:
    """Encode un entier positif en varint protobuf (7 bits utiles par octet, bit de poids
    fort = continuation)."""
    out = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        out.append(chunk | (0x80 if value else 0))
        if not value:
            return bytes(out)


def _length_delimited(field_number: int, payload: bytes) -> bytes:
    """Encode un champ protobuf de type 2 (longueur préfixée) : tag, longueur, contenu."""
    tag = (field_number << 3) | 2
    return _varint(tag) + _varint(len(payload)) + payload


def public_key_der(private_key: rsa.RSAPrivateKey) -> bytes:
    """Clé publique au format X.509 SubjectPublicKeyInfo (DER), tel qu'attendu dans le CRX."""
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def extension_id(public_key: bytes) -> str:
    """Identifiant Chrome dérivé de la clé publique : 16 premiers octets du SHA-256, chaque
    quartet hexadécimal étant décalé dans l'alphabet `a`-`p` (32 caractères)."""
    digest = hashlib.sha256(public_key).digest()[:_CRX_ID_BYTES]
    base = ord("a")
    return "".join(chr(base + (byte >> 4)) + chr(base + (byte & 0x0F)) for byte in digest)


def _create_exclusive(path: Path, payload: bytes) -> None:
    """Crée `path` en `0600` et y écrit `payload`, en échouant si le fichier existe déjà."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)


def _write_key(key_path: Path, private_key: rsa.RSAPrivateKey) -> None:
    """Écrit la clé privée en PEM avec des permissions `0600` dès la création.

    Passage par un fichier temporaire puis `os.link` : `O_EXCL` crée le fichier VIDE avant
    l'écriture, si bien qu'un process concurrent qui perd la course pouvait lire un PEM
    tronqué. Le lien dur ne publie le nom définitif qu'une fois le contenu complet, et échoue
    (`FileExistsError`) si un pair a déjà déposé sa clé — jamais d'écrasement. Repli sur la
    création exclusive directe pour les systèmes de fichiers sans lien dur.
    """
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    staging = key_path.parent / f".{KEY_FILENAME}.{uuid.uuid4().hex}"
    try:
        _create_exclusive(staging, pem)
        try:
            os.link(staging, key_path)
        except FileExistsError:
            raise
        except OSError:
            _create_exclusive(key_path, pem)
    finally:
        staging.unlink(missing_ok=True)


def _load_key(key_path: Path) -> rsa.RSAPrivateKey:
    """Charge une clé RSA existante, en refusant tout autre type de clé."""
    key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError(
            f"Clé de signature inattendue dans {key_path} : une clé RSA est requise pour "
            "signer une extension Chrome. Supprimer le fichier pour en régénérer une."
        )
    return key


def load_or_create_key(key_dir: Path) -> rsa.RSAPrivateKey:
    """Retourne la clé de signature persistante, générée au premier appel puis mémoïsée.

    Cette clé DOIT survivre aux reconstructions d'image (elle vit dans `EZDL_DATA_DIR`) :
    l'identifiant de l'extension en dérive, et un identifiant qui change ferait apparaître
    chaque publication comme une extension différente au lieu d'une mise à jour.

    La mémoïsation n'est pas qu'une optimisation : les routes `/extension` sont publiques,
    et un dossier de données non inscriptible ferait sinon regénérer une clé RSA 2048 à
    chaque requête — une amplification CPU offerte à n'importe quel visiteur.
    """
    key_path = key_dir / KEY_FILENAME
    with _keys_lock:
        cached = _keys.get(key_path)
        if cached is not None:
            return cached
        key = _load_key(key_path) if key_path.exists() else _generate_key(key_dir, key_path)
        _keys[key_path] = key
        return key


def _generate_key(key_dir: Path, key_path: Path) -> rsa.RSAPrivateKey:
    """Génère et persiste une nouvelle clé de signature."""
    key_dir.mkdir(parents=True, exist_ok=True)
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=_KEY_SIZE_BITS)
    try:
        _write_key(key_path, private_key)
    except FileExistsError:
        # Un autre worker a gagné la course : sa clé fait foi, la nôtre est jetée.
        return _load_key(key_path)
    return private_key


def pack(archive: bytes, private_key: rsa.RSAPrivateKey) -> bytes:
    """Produit l'archive CRX3 signée à partir du zip de l'extension."""
    public_key = public_key_der(private_key)
    crx_id = hashlib.sha256(public_key).digest()[:_CRX_ID_BYTES]
    signed_header_data = _length_delimited(_FIELD_CRX_ID, crx_id)

    signature = private_key.sign(
        _SIGNATURE_CONTEXT
        + len(signed_header_data).to_bytes(4, "little")
        + signed_header_data
        + archive,
        padding.PKCS1v15(),
        hashes.SHA256(),
    )

    proof = _length_delimited(_FIELD_PUBLIC_KEY, public_key) + _length_delimited(
        _FIELD_SIGNATURE, signature
    )
    header = _length_delimited(_FIELD_SHA256_WITH_RSA, proof) + _length_delimited(
        _FIELD_SIGNED_HEADER_DATA, signed_header_data
    )

    return (
        CRX_MAGIC
        + CRX_FORMAT_VERSION.to_bytes(4, "little")
        + len(header).to_bytes(4, "little")
        + header
        + archive
    )


def signing_identity(key_dir: Path) -> str:
    """Identifiant Chrome que prendra tout `.crx` signé par ce serveur.

    Publié à l'utilisateur : c'est son seul moyen de vérifier, dans `chrome://extensions`,
    que l'extension installée vient bien de ce serveur et pas d'un artefact substitué.
    """
    return extension_id(public_key_der(load_or_create_key(key_dir)))


def build_signed_crx(archive_path: Path, cache_dir: Path, key_dir: Path) -> Path:
    """Retourne le chemin du `.crx` signé, reconstruit uniquement si le zip a changé.

    La signature est trop coûteuse pour être refaite à chaque téléchargement : le résultat
    est mis en cache sous un nom dérivé du SHA-256 de l'archive. Indexer sur le CONTENU et
    non sur l'horodatage évite de republier indéfiniment un artefact périmé quand un rebuild
    produit un zip dont le mtime n'a pas avancé (build reproductible, restauration de
    sauvegarde) sans que la version ait bougé.
    """
    archive = archive_path.read_bytes()
    digest = hashlib.sha256(archive).hexdigest()[:_CACHE_DIGEST_CHARS]
    target = cache_dir / f"{_CACHE_PREFIX}-{digest}.crx"
    if target.exists():
        return target

    payload = pack(archive, load_or_create_key(key_dir))

    cache_dir.mkdir(parents=True, exist_ok=True)
    # Écriture atomique : une requête concurrente ne doit jamais lire un `.crx` partiel.
    staging = cache_dir / f".{target.name}.{uuid.uuid4().hex}.part"
    staging.write_bytes(payload)
    os.replace(staging, target)

    for stale in cache_dir.glob("*.crx"):
        if stale.name != target.name:
            stale.unlink(missing_ok=True)
    return target
