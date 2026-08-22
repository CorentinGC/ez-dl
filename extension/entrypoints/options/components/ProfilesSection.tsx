/**
 * Gestion des serveurs enregistrés : sélection du profil édité par les sections ci-dessous,
 * renommage, bascule du profil actif (celui qu'utilise la popup), duplication et suppression.
 *
 * Le mot de passe n'apparaît jamais ici — seule la section Serveur l'affiche, masqué.
 */

import { useEffect, useState } from 'react';
import type { ServerProfile } from '@/src/lib/types';

interface ProfilesSectionProps {
  profiles: ServerProfile[];
  activeProfileId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onActivate: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
}

export function ProfilesSection({
  profiles,
  activeProfileId,
  selectedId,
  onSelect,
  onRename,
  onActivate,
  onDuplicate,
  onRemove,
}: ProfilesSectionProps) {
  const isLastProfile = profiles.length <= 1;

  return (
    <section className="options-section">
      <h2>Serveurs</h2>
      <p className="options-section-description">
        Plusieurs serveurs ez-dl peuvent être enregistrés. Le serveur <strong>actif</strong> est celui qu'utilise la popup ; les
        réglages ci-dessous s'appliquent au serveur <strong>sélectionné</strong>, qui peut être différent.
      </p>

      <ul className="profile-list">
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            isActive={profile.id === activeProfileId}
            isSelected={profile.id === selectedId}
            isLastProfile={isLastProfile}
            onSelect={() => onSelect(profile.id)}
            onRename={(name) => onRename(profile.id, name)}
            onActivate={() => onActivate(profile.id)}
            onDuplicate={() => onDuplicate(profile.id)}
            onRemove={() => {
              if (window.confirm(`Supprimer le serveur « ${profile.name} » et ses réglages ?`)) onRemove(profile.id);
            }}
          />
        ))}
      </ul>

      <button type="button" className="btn" disabled={!selectedId} onClick={() => selectedId && onDuplicate(selectedId)}>
        + Ajouter un serveur
      </button>
      <p className="options-hint">
        Le nouveau serveur part d'une copie du serveur sélectionné : URL, dossiers favoris et preset sont repris, il ne reste qu'à
        adapter ce qui change.
      </p>
    </section>
  );
}

interface ProfileRowProps {
  profile: ServerProfile;
  isActive: boolean;
  isSelected: boolean;
  isLastProfile: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onActivate: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function ProfileRow({
  profile,
  isActive,
  isSelected,
  isLastProfile,
  onSelect,
  onRename,
  onActivate,
  onDuplicate,
  onRemove,
}: ProfileRowProps) {
  const [draftName, setDraftName] = useState(profile.name);

  // Renommage depuis un autre contexte (autre fenêtre d'options) : suivre la valeur stockée.
  useEffect(() => setDraftName(profile.name), [profile.name]);

  return (
    <li className={`profile-row${isSelected ? ' is-selected' : ''}`}>
      {isSelected ? (
        <input
          className="field-input profile-name-input"
          aria-label="Nom du serveur"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => onRename(draftName.trim())}
        />
      ) : (
        <button type="button" className="profile-name" onClick={onSelect}>
          {profile.name}
        </button>
      )}

      <span className="profile-url">{profile.serverUrl || 'Aucune URL'}</span>

      {isActive ? (
        <span className="profile-badge-active">Actif</span>
      ) : (
        <button type="button" className="btn btn-small" onClick={onActivate}>
          Utiliser
        </button>
      )}
      <button type="button" className="btn btn-small" onClick={onDuplicate}>
        Dupliquer
      </button>
      <button
        type="button"
        className="btn btn-small btn-danger"
        disabled={isLastProfile}
        title={isLastProfile ? 'Au moins un serveur doit rester enregistré.' : undefined}
        onClick={onRemove}
      >
        Supprimer
      </button>
    </li>
  );
}
