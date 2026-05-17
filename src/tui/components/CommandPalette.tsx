/**
 * ABOUTME: Command palette modal for the PRD chat interface.
 * Opens with Ctrl+K, provides keyboard-discoverable commands with filtering.
 */

import type { KeyEvent } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { colors } from '../theme.js';

/**
 * A single command available in the palette.
 */
export interface CommandEntry {
  /** Slash-command string, e.g. "/clear-images" */
  command: string;
  /** Short description shown beside the command */
  description: string;
  /** Called when the user executes this command */
  execute: () => void;
}

/**
 * Props for CommandPalette
 */
export interface CommandPaletteProps {
  /** Whether the palette is currently visible */
  visible: boolean;
  /** Available commands to display */
  commands: CommandEntry[];
  /** Callback to close the palette */
  onClose: () => void;
}

/**
 * Command palette modal with type-to-filter and arrow-key navigation.
 */
export function CommandPalette({ visible, commands, onClose }: CommandPaletteProps): ReactNode {
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Reset state when palette opens
  useEffect(() => {
    if (visible) {
      setFilter('');
      setSelectedIndex(0);
    }
  }, [visible]);

  const filteredCommands = useMemo(() => {
    if (!filter) return commands;
    const q = filter.toLowerCase();
    return commands.filter(
      (c) =>
        c.command.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [commands, filter]);

  // Keep selectedIndex in bounds when filtered list shrinks
  useEffect(() => {
    if (selectedIndex >= filteredCommands.length && filteredCommands.length > 0) {
      setSelectedIndex(filteredCommands.length - 1);
    }
  }, [filteredCommands.length, selectedIndex]);

  const handleKeyboard = useCallback(
    (key: KeyEvent) => {
      if (!visible) return;

      if (key.name === 'escape') {
        key.preventDefault?.();
        onClose();
        return;
      }

      if (key.name === 'up') {
        key.preventDefault?.();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredCommands.length - 1));
        return;
      }

      if (key.name === 'down') {
        key.preventDefault?.();
        setSelectedIndex((prev) => (prev < filteredCommands.length - 1 ? prev + 1 : 0));
        return;
      }

      if (key.name === 'return' && !key.ctrl && !key.shift && !key.meta) {
        key.preventDefault?.();
        const selected = filteredCommands[selectedIndex];
        if (selected) {
          selected.execute();
        }
        onClose();
        return;
      }

      // Backspace in filter field
      if (key.name === 'backspace') {
        key.preventDefault?.();
        setFilter((prev) => prev.slice(0, -1));
        return;
      }

      // Printable characters appended to filter
      if (key.name && key.name.length === 1) {
        key.preventDefault?.();
        setFilter((prev) => prev + key.name);
        return;
      }
    },
    [visible, filteredCommands, selectedIndex, onClose],
  );

  useKeyboard(handleKeyboard);

  if (!visible) return null;

  return (
    <box
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'flex-start',
        alignItems: 'center',
        backgroundColor: colors.bg.overlay,
      }}
    >
      <box
        style={{
          width: 60,
          marginTop: 4,
          backgroundColor: colors.bg.secondary,
          border: true,
          borderColor: colors.accent.primary,
          flexDirection: 'column',
          padding: 0,
        }}
      >
        {/* Filter input area */}
        <box
          style={{
            height: 3,
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 2,
            paddingRight: 2,
          }}
        >
          <text fg={colors.accent.primary}>{'>'} </text>
          <text fg={colors.fg.primary}>{filter || 'Type to filter...'}</text>
        </box>

        {/* Command list */}
        <scrollbox
          style={{
            height: Math.min(filteredCommands.length + 1, 10),
            padding: 0,
          }}
        >
          {filteredCommands.length === 0 ? (
            <box style={{ height: 2, alignItems: 'center', justifyContent: 'center', paddingLeft: 2 }}>
              <text fg={colors.fg.muted}>No commands found</text>
            </box>
          ) : (
            filteredCommands.map((cmd, index) => {
              const isSelected = index === selectedIndex;
              return (
                <box
                  key={cmd.command}
                  style={{
                    height: 2,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingLeft: 2,
                    paddingRight: 2,
                    backgroundColor: isSelected ? colors.bg.highlight : undefined,
                  }}
                >
                  <text fg={isSelected ? colors.accent.primary : colors.accent.secondary}>
                    {cmd.command}
                  </text>
                  <text fg={isSelected ? colors.fg.primary : colors.fg.muted}>
                    {' '}- {cmd.description}
                  </text>
                </box>
              );
            })
          )}
        </scrollbox>

        {/* Footer hint */}
        <box
          style={{
            height: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <text fg={colors.fg.muted}>
            {'\u2191\u2193'} navigate  [Enter] execute  [Esc] close
          </text>
        </box>
      </box>
    </box>
  );
}
