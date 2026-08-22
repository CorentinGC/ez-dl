/**
 * Marque ez-dl en SVG inline : flèche descendante plongeant dans un bac ouvert.
 *
 * Géométrie reprise de `assets/icon.svg`, la référence — toute retouche là-bas doit être
 * répercutée ici. Inline plutôt qu'une balise `img` vers `public/icon/` : la tuile suit alors
 * l'accent de la popup (`--ez-accent`), donc le thème clair/sombre, sans second fichier.
 */

interface BrandMarkProps {
  /** Côté du carré, en pixels CSS. */
  size?: number;
}

export function BrandMark({ size = 18 }: BrandMarkProps) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      // Décoratif : le nom « ez-dl » est déjà rendu en texte à côté.
      aria-hidden="true"
      focusable="false"
    >
      <rect width="24" height="24" rx="5" fill="var(--ez-accent)" />
      <g color="var(--ez-accent-contrast)">
        <rect x="10.6" y="3.2" width="2.8" height="6.8" rx="1.4" fill="currentColor" />
        <path d="M7.2 9.2h9.6L12 14z" fill="currentColor" />
        <path
          d="M3.6 17.4V19.8H20.4V17.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
