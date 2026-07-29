// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ui.tsx';

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open confirmation</button>
      {open ? (
        <ConfirmDialog
          title="Delete synthetic ride"
          body={<p>This removes invented test data.</p>}
          confirmLabel="Delete"
          danger
          onConfirm={() => undefined}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe('ConfirmDialog keyboard behavior', () => {
  it('places and traps focus, closes on Escape, and restores the trigger', () => {
    const view = render(<DialogHarness />);
    const trigger = view.getByRole('button', { name: 'Open confirmation' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = view.getByRole('alertdialog');
    const cancel = view.getByRole('button', { name: 'Cancel' });
    const confirm = view.getByRole('button', { name: 'Delete' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('cannot dismiss through Escape or the overlay while work is in progress', () => {
    const onCancel = vi.fn();
    const view = render(
      <ConfirmDialog
        title="Restore synthetic backup"
        body={<p>This replaces invented test data.</p>}
        confirmLabel="Restore"
        busy
        onConfirm={() => undefined}
        onCancel={onCancel}
      />,
    );
    const dialog = view.getByRole('alertdialog');
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog.parentElement!);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
