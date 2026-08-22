/**
 * Types des messages échangés entre background, popup, options et content script.
 *
 * Transport (API `chrome`/`browser` natives, pas de polyfill) :
 * - popup/options -> background : `browser.runtime.sendMessage` (promesse native MV3).
 * - content -> background : `browser.runtime.sendMessage` (le background lit `sender.tab.id`).
 * - background -> content (onglet précis) : `browser.tabs.sendMessage(tabId, ...)`.
 * - background -> popup/options ouvertes : `browser.runtime.sendMessage` en broadcast, reçu
 *   uniquement si une page d'extension a un listener actif à cet instant.
 *
 * Les listeners `onMessage` restent synchrones et renvoient `true` pour une réponse
 * asynchrone (le natif `chrome.runtime.onMessage` ne comprend pas un listener `async`).
 */

import type { PageInfo, PickedElementInfo, SiteRule, TabState } from './types';

// ---------------------------------------------------------------------------
// Popup/options -> background
// ---------------------------------------------------------------------------

/** Récupère l'état sniffé d'un onglet (candidats + info de page + résultat picker). */
export interface GetTabStateRequest {
  type: 'GET_TAB_STATE';
  /** Onglet ciblé ; par défaut l'onglet actif de la fenêtre courante. */
  tabId?: number;
}

export type GetTabStateResponse = TabState & { tabId: number };

/** Efface l'état sniffé d'un onglet (action manuelle depuis la popup). */
export interface ClearTabRequest {
  type: 'CLEAR_TAB';
  tabId: number;
}

/** Active le mode picker DOM dans le content script d'un onglet. */
export interface StartPickerRequest {
  type: 'START_PICKER';
  tabId: number;
}

/** Enregistre une règle de site (manuelle ou déduite du picker) via `POST /api/rules`. */
export interface SaveRuleRequest {
  type: 'SAVE_RULE';
  domain: string;
  urlPattern: string;
  label?: string;
  notes?: string;
  source: 'manual' | 'learned';
}

export type SaveRuleResponse = { ok: true; rule: SiteRule } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Content -> background
// ---------------------------------------------------------------------------

/** Poussée par le content script au chargement de page (titre, vidéos, OpenGraph). */
export interface PageInfoMessage {
  type: 'PAGE_INFO';
  pageInfo: PageInfo;
}

/** Élément choisi par l'utilisateur en mode picker. */
export interface PickedElementMessage {
  type: 'PICKED_ELEMENT';
  element: PickedElementInfo;
}

/** L'utilisateur a annulé le picker (Échap) sans choisir d'élément. */
export interface PickerCancelledMessage {
  type: 'PICKER_CANCELLED';
}

/**
 * Le content script a repéré une vidéo exploitable et demande si la page offre une source
 * téléchargeable. Aucune donnée de la page n'est transmise : le background ne fait confiance
 * qu'à `sender.tab` (identifiant et URL réels de l'onglet).
 */
export interface OverlayCheckRequest {
  type: 'OVERLAY_CHECK';
}

export interface OverlayCheckResponse {
  /** `true` seulement si un flux sniffé ou un probe exploitable existe **et** que le serveur
   * est configuré **et** que la préférence `showPageOverlay` est active. */
  available: boolean;
}

/** Clic sur le bouton en overlay : crée un job avec tous les réglages par défaut. */
export interface QuickDownloadRequest {
  type: 'QUICK_DOWNLOAD';
}

export type QuickDownloadResponse = { ok: true; jobId: string } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Background -> content (ciblé via `browser.tabs.sendMessage`)
// ---------------------------------------------------------------------------

export interface ActivatePickerMessage {
  type: 'ACTIVATE_PICKER';
}

export interface DeactivatePickerMessage {
  type: 'DEACTIVATE_PICKER';
}

/** Demande au content script un instantané frais des infos de page (titre/vidéos/OG). */
export interface GetPageInfoMessage {
  type: 'GET_PAGE_INFO';
}

/**
 * Une source vient d'apparaître sur l'onglet (flux sniffé après le chargement) : le content
 * script peut afficher son bouton sans re-interroger le background.
 */
export interface OverlayAvailableMessage {
  type: 'OVERLAY_AVAILABLE';
}

// ---------------------------------------------------------------------------
// Background -> popup/options (broadcast best-effort)
// ---------------------------------------------------------------------------

/** Notifie qu'un nouveau candidat a été détecté sur un onglet (rafraîchissement live). */
export interface TabStateUpdatedMessage {
  type: 'TAB_STATE_UPDATED';
  tabId: number;
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/** Messages reçus par le listener unique du background. */
export type BackgroundRequest =
  | GetTabStateRequest
  | ClearTabRequest
  | StartPickerRequest
  | SaveRuleRequest
  | PageInfoMessage
  | PickedElementMessage
  | PickerCancelledMessage
  | OverlayCheckRequest
  | QuickDownloadRequest;

/** Messages reçus par le content script. */
export type ContentRequest =
  | ActivatePickerMessage
  | DeactivatePickerMessage
  | GetPageInfoMessage
  | OverlayAvailableMessage;

/** Messages diffusés par le background vers les pages d'extension ouvertes. */
export type ExtensionBroadcast = TabStateUpdatedMessage;

/** Détecteur générique de type de message (évite les casts hasardeux dans les listeners). */
export function hasMessageType<T extends string>(message: unknown, type: T): message is { type: T } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === type;
}
