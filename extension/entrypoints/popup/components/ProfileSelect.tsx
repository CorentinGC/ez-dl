/**
 * Bascule rapide entre serveurs enregistrés. Masqué tant qu'un seul profil existe : un
 * sélecteur à une seule entrée n'apporterait rien et mangerait la largeur de l'en-tête.
 */

import type { ServerProfile } from '@/src/lib/types';

interface ProfileSelectProps {
  profiles: ServerProfile[];
  activeProfileId: string | null;
  onSelect: (id: string) => void;
}

export function ProfileSelect({ profiles, activeProfileId, onSelect }: ProfileSelectProps) {
  if (profiles.length < 2) return null;

  return (
    <select
      className="popup-profile-select"
      aria-label="Serveur actif"
      title="Serveur actif"
      value={activeProfileId ?? ''}
      onChange={(event) => onSelect(event.target.value)}
    >
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
        </option>
      ))}
    </select>
  );
}
