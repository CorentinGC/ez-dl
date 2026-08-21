/**
 * En-tête de la popup : marque, onglets Sources/Jobs, accès rapide aux réglages.
 */

export type PopupView = 'sources' | 'jobs';

interface HeaderProps {
  activeView: PopupView;
  onChangeView: (view: PopupView) => void;
  sourceCount: number;
  jobCount: number;
}

export function Header({ activeView, onChangeView, sourceCount, jobCount }: HeaderProps) {
  return (
    <header className="popup-header">
      <span className="popup-brand">ez-dl</span>
      <nav className="popup-tabs" role="tablist" aria-label="Sections de la popup">
        <TabButton label="Sources" count={sourceCount} active={activeView === 'sources'} onClick={() => onChangeView('sources')} />
        <TabButton label="Jobs" count={jobCount} active={activeView === 'jobs'} onClick={() => onChangeView('jobs')} />
      </nav>
      <button
        type="button"
        className="popup-icon-button"
        title="Réglages"
        aria-label="Ouvrir les réglages de l'extension"
        onClick={() => browser.runtime.openOptionsPage()}
      >
        ⚙
      </button>
    </header>
  );
}

function TabButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`popup-tab${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {label}
      {count > 0 ? <span className="popup-tab-count">{count}</span> : null}
    </button>
  );
}
