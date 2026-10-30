import React from 'react';

interface ClickableCardProps {
  children: React.ReactNode;
  onActivate: () => void;
  className?: string;
  /** Accessible name when the card's text is not a complete description. */
  ariaLabel?: string;
  title?: string;
}

/**
 * A real button for card-shaped navigation.
 *
 * Dashboard branch cards and global-search result cards used to be clickable
 * `<div>`s: reachable by mouse, invisible to keyboard and assistive technology.
 * Rendering a native button restores Tab, Enter/Space, focus and button
 * semantics without changing the visual layout.
 */
export const ClickableCard: React.FC<ClickableCardProps> = ({
  children,
  onActivate,
  className = '',
  ariaLabel,
  title,
}) => (
  <button
    type="button"
    onClick={onActivate}
    aria-label={ariaLabel}
    title={title}
    className={`text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 ${className}`}
  >
    {children}
  </button>
);

export default ClickableCard;
