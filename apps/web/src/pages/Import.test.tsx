// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ImportPage } from './Import.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Import file chooser accessibility', () => {
  it('keeps the drop surface non-interactive and uses a native Space/Enter button', () => {
    const view = render(
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>,
    );

    const dropSurface = screen.getByRole('group', { name: 'File import drop area' });
    expect(dropSurface.tagName).toBe('DIV');
    expect(dropSurface.tabIndex).toBe(-1);
    expect(dropSurface.matches('button, [role="button"]')).toBe(false);

    const chooser = screen.getByRole('button', { name: 'Choose files' });
    expect(chooser.tagName).toBe('BUTTON');
    expect(chooser.closest('[role="button"]')).toBeNull();

    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    chooser.focus();
    // Native <button> semantics provide keyboard Enter/Space activation; the
    // click verifies the explicit control owns the chooser action.
    fireEvent.click(chooser);
    expect(document.activeElement).toBe(chooser);
    expect(click).toHaveBeenCalledOnce();
  });
});
