/**
 * Integration tests for rich text fields with Y.XmlFragment
 *
 * Tests sync behavior for documents with rich text fields.
 * Basic CRUD is covered in crud.test.ts - these focus on XmlFragment sync.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fragmentFromJSON, isDoc, serializeYMapValue } from '$/client/merge.js';
import type { XmlFragmentJSON } from '$/shared/types.js';
import { createTestDoc, createTestMap, applyUpdate } from '../utils/yjs.js';

interface Note {
  id: string;
  title: string;
  content: XmlFragmentJSON;
}

interface TestRichTextCollection<T extends { id: string }> {
  doc: Y.Doc;
  ymap: Y.Map<unknown>;

  insert(item: T): { delta: Uint8Array };
  getFragment(id: string, field: string): Y.XmlFragment | null;
  get(id: string): T | null;
}

function createRichTextCollection<T extends { id: string }>(
  name: string,
  clientId?: number
): TestRichTextCollection<T> {
  const doc = createTestDoc(clientId);
  const ymap = createTestMap(doc, name);

  return {
    doc,
    ymap,

    insert(item: T): { delta: Uint8Array } {
      const beforeVector = Y.encodeStateVector(doc);
      doc.transact(() => {
        const itemMap = new Y.Map();
        for (const [key, value] of Object.entries(item)) {
          if (isDoc(value)) {
            const fragment = new Y.XmlFragment();
            if (value.content) {
              fragmentFromJSON(fragment, value);
            }
            itemMap.set(key, fragment);
          } else {
            itemMap.set(key, value);
          }
        }
        ymap.set(item.id, itemMap);
      });
      return { delta: Y.encodeStateAsUpdateV2(doc, beforeVector) };
    },

    get(id: string): T | null {
      const value = ymap.get(id);
      return value instanceof Y.Map ? (serializeYMapValue(value) as T) : null;
    },

    getFragment(id: string, field: string): Y.XmlFragment | null {
      const itemMap = ymap.get(id);
      if (!(itemMap instanceof Y.Map)) return null;
      const fieldValue = itemMap.get(field);
      return fieldValue instanceof Y.XmlFragment ? fieldValue : null;
    },
  };
}

/** Helper to create a ProseMirror doc JSON structure */
function proseMirrorDoc(content?: XmlFragmentJSON['content']): XmlFragmentJSON {
  return { type: 'doc', content };
}

describe('XmlFragment sync', () => {
  it('syncs XmlFragment between two clients via deltas', () => {
    const collection1 = createRichTextCollection<Note>('notes', 1);
    const collection2 = createRichTextCollection<Note>('notes', 2);

    // Insert with rich content
    const { delta: insertDelta } = collection1.insert({
      id: 'note-1',
      title: 'Synced',
      content: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Sync me!' }] },
      ]),
    });

    applyUpdate(collection2.doc, insertDelta);

    // Verify sync
    const note2 = collection2.get('note-1');
    expect(note2?.content.content?.[0].content?.[0].text).toBe('Sync me!');
    expect(collection2.getFragment('note-1', 'content')).toBeInstanceOf(Y.XmlFragment);
  });

  it('direct fragment edits produce syncable deltas', () => {
    const collection1 = createRichTextCollection<Note>('notes', 1);
    const collection2 = createRichTextCollection<Note>('notes', 2);

    // Initial sync
    const { delta: insertDelta } = collection1.insert({
      id: 'note-1',
      title: 'Note',
      content: proseMirrorDoc(),
    });
    applyUpdate(collection2.doc, insertDelta);

    // Direct fragment edit (simulating editor binding)
    const frag = collection1.getFragment('note-1', 'content');
    expect(frag).not.toBeNull();
    if (!frag) return;

    const beforeVector = Y.encodeStateVector(collection1.doc);
    collection1.doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Direct edit from editor');
      paragraph.insert(0, [text]);
      frag.insert(0, [paragraph]);
    });
    const editDelta = Y.encodeStateAsUpdateV2(collection1.doc, beforeVector);

    applyUpdate(collection2.doc, editDelta);

    // Verify sync
    const note2 = collection2.get('note-1');
    expect(note2?.content.content?.[0].content?.[0].text).toBe('Direct edit from editor');
  });
});
