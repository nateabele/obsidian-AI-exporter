/**
 * UI components for content script
 * Toast notifications and shared style injection. The sync icon itself
 * lives in src/content/sync-icon.ts.
 */

import {
  DEFAULT_TOAST_DURATION,
  SUCCESS_TOAST_DURATION,
  ERROR_TOAST_DURATION,
  WARNING_TOAST_DURATION,
} from '../lib/constants';
import { getMessage } from '../lib/i18n';

// CSS styles for UI components
const STYLES = `
  #g2o-sync-icon {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: none;
    border-radius: 50%;
    color: white;
    font-size: 18px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    transition: all 0.2s ease;
    background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
  }

  #g2o-sync-icon[data-state='offline'] {
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  }

  #g2o-sync-icon[data-state='syncing'] {
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  }

  #g2o-sync-icon[data-state='synced'] {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  }

  #g2o-sync-icon[data-state='suggestions'] {
    background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
  }

  /* Same amber as the warning toast (see .g2o-toast.warning below) — a
     blocked local extraction/manifest issue, not a companion connectivity
     failure (which stays offline's red). */
  #g2o-sync-icon[data-state='attention'] {
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  }

  /* No override for disabled -- it deliberately shares the same neutral
     gray as the base rule above and unconfigured (which also has no
     override): a platform excluded from auto-sync is a quiet, expected
     state, not a health claim to draw the eye toward or away from. */

  #g2o-sync-icon:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
  }

  #g2o-sync-icon:active {
    transform: translateY(0);
  }

  #g2o-sync-icon[data-state='syncing'] .glyph {
    display: inline-block;
    animation: g2o-spin 0.8s linear infinite;
  }

  #g2o-sync-icon .badge {
    position: absolute;
    top: -4px;
    right: -4px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: #ef4444;
    color: white;
    font-size: 10px;
    font-weight: 700;
  }

  @keyframes g2o-spin {
    to { transform: rotate(360deg); }
  }

  #g2o-sync-menu {
    position: fixed;
    bottom: 68px;
    right: 20px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    min-width: 200px;
    padding: 8px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
  }

  #g2o-sync-menu .entry {
    padding: 8px 12px;
    border: none;
    border-radius: 8px;
    background: none;
    color: #111827;
    text-align: left;
    cursor: pointer;
  }

  #g2o-sync-menu .entry:hover {
    background: #f3f4f6;
  }

  #g2o-sync-menu .error-detail {
    padding: 4px 12px 8px;
    color: #dc2626;
    font-size: 12px;
  }

  #g2o-sync-menu .attention-detail {
    padding: 4px 12px 8px;
    color: #d97706;
    font-size: 12px;
  }

  #g2o-sync-menu .note-detail {
    padding: 4px 12px 8px;
    color: #6b7280;
    font-size: 12px;
  }

  #g2o-sync-menu .group {
    padding: 8px 12px 4px;
    color: #6b7280;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .g2o-toast {
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 10001;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px;
    border-radius: 12px;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    animation: g2o-slideIn 0.3s ease;
    max-width: 400px;
  }

  @keyframes g2o-slideIn {
    from {
      opacity: 0;
      transform: translateX(100px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .g2o-toast.success {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    color: white;
  }

  .g2o-toast.error {
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    color: white;
  }

  .g2o-toast.warning {
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    color: white;
  }

  .g2o-toast.info {
    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
    color: white;
  }

  .g2o-toast .icon {
    font-size: 18px;
    flex-shrink: 0;
  }

  .g2o-toast .message {
    flex: 1;
    line-height: 1.4;
  }

  .g2o-toast .close {
    background: none;
    border: none;
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    font-size: 18px;
    padding: 0;
    margin-left: 8px;
  }

  .g2o-toast .close:hover {
    opacity: 1;
  }
`;

let styleInjected = false;
let currentToast: HTMLDivElement | null = null;

/**
 * Inject CSS styles into the page.
 *
 * Exported so sync-icon.ts (which owns the `#g2o-sync-icon` / `#g2o-sync-menu`
 * rules defined in STYLES above) can share the same injected `<style>` tag
 * and the same "only once" guard as toast rendering.
 */
export function injectStyles(): void {
  if (styleInjected) return;

  const style = document.createElement('style');
  style.id = 'g2o-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
  styleInjected = true;
}

type ToastType = 'success' | 'error' | 'warning' | 'info';

const TOAST_ICONS: Record<ToastType, string> = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

/**
 * Show a toast notification
 */
export function showToast(
  message: string,
  type: ToastType = 'info',
  duration: number = DEFAULT_TOAST_DURATION
): void {
  injectStyles();

  // Remove existing toast if present
  if (currentToast) {
    currentToast.remove();
    currentToast = null;
  }

  const toast = document.createElement('div');
  toast.className = `g2o-toast ${type}`;
  currentToast = toast;

  const toastIcon = document.createElement('span');
  toastIcon.className = 'icon';
  toastIcon.textContent = TOAST_ICONS[type];

  const toastMessage = document.createElement('span');
  toastMessage.className = 'message';
  toastMessage.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => {
    toast.remove();
    if (currentToast === toast) {
      currentToast = null;
    }
  });

  toast.appendChild(toastIcon);
  toast.appendChild(toastMessage);
  toast.appendChild(closeBtn);

  document.body.appendChild(toast);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => {
      if (currentToast !== toast) return;
      toast.style.animation = 'g2o-slideIn 0.3s ease reverse';
      setTimeout(() => {
        toast.remove();
        if (currentToast === toast) {
          currentToast = null;
        }
      }, 300);
    }, duration);
  }
}

/**
 * Show success toast with file info
 */
export function showSuccessToast(fileName: string, isNewFile: boolean): void {
  const messageKey = isNewFile ? 'toast_success_created' : 'toast_success_updated';
  showToast(getMessage(messageKey, fileName), 'success', SUCCESS_TOAST_DURATION);
}

/**
 * Show error toast with details
 */
export function showErrorToast(error: string): void {
  showToast(error, 'error', ERROR_TOAST_DURATION);
}

/**
 * Show warning toast
 */
export function showWarningToast(message: string): void {
  showToast(message, 'warning', WARNING_TOAST_DURATION);
}
