/**
 * Integration tests for rich text fields with Y.XmlFragment
 *
 * Tests the full CRUD + sync cycle for documents with rich text fields.
 * Uses isDoc for auto-detection of prose fields.
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
  update(id: string, changes: Partial<T>): { delta: Uint8Array };
  delete(id: string): { delta: Uint8Array };
  get(id: string): T | null;
  getFragment(id: string, field: string): Y.XmlFragment | null;
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

    update(id: string, changes: Partial<T>): { delta: Uint8Array } {
      const beforeVector = Y.encodeStateVector(doc);
      doc.transact(() => {
        const itemMap = ymap.get(id);
        if (itemMap instanceof Y.Map) {
          for (const [key, value] of Object.entries(changes)) {
            if (isDoc(value)) {
              const existingFragment = itemMap.get(key);
              if (existingFragment instanceof Y.XmlFragment) {
                while (existingFragment.length > 0) {
                  existingFragment.delete(0);
                }
                if (value.content) {
                  fragmentFromJSON(existingFragment, value);
                }
              } else {
                const fragment = new Y.XmlFragment();
                if (value.content) {
                  fragmentFromJSON(fragment, value);
                }
                itemMap.set(key, fragment);
              }
            } else {
              itemMap.set(key, value);
            }
          }
        }
      });
      return { delta: Y.encodeStateAsUpdateV2(doc, beforeVector) };
    },

    delete(id: string): { delta: Uint8Array } {
      const beforeVector = Y.encodeStateVector(doc);
      doc.transact(() => {
        ymap.delete(id);
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

describe('rich text fields', () => {
  it('inserts document with rich text content and internal XmlFragment structure', () => {
    const collection = createRichTextCollection<Note>('notes');

    collection.insert({
      id: 'note-1',
      title: 'Test Note',
      content: proseMirrorDoc([
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and normal' },
          ],
        },
      ]),
    });

    const note = collection.get('note-1');
    expect(note?.id).toBe('note-1');
    expect(note?.title).toBe('Test Note');
    expect(note?.content.content?.[0].content).toHaveLength(2);
    expect(note?.content.content?.[0].content?.[0].marks?.[0].type).toBe('bold');

    // Verify internal Y.XmlFragment structure
    const itemMap = collection.ymap.get('note-1') as Y.Map<unknown>;
    expect(itemMap.get('content')).toBeInstanceOf(Y.XmlFragment);
  });

  it('updates both primitive and XmlFragment fields together', () => {
    const collection = createRichTextCollection<Note>('notes');

    collection.insert({
      id: 'note-1',
      title: 'Original',
      content: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Original content' }] },
      ]),
    });

    collection.update('note-1', {
      title: 'Updated Title',
      content: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'New content' }] },
      ]),
    });

    const note = collection.get('note-1');
    expect(note?.title).toBe('Updated Title');
    expect(note?.content.content?.[0].content?.[0].text).toBe('New content');
  });

  it('getFragment returns live fragment for editor binding', () => {
    const collection = createRichTextCollection<Note>('notes');

    collection.insert({
      id: 'note-1',
      title: 'Test',
      content: proseMirrorDoc(),
    });

    const frag = collection.getFragment('note-1', 'content');
    expect(frag).toBeInstanceOf(Y.XmlFragment);
    if (!frag) return;

    // Directly modify fragment (simulating editor binding)
    collection.doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Direct edit');
      paragraph.insert(0, [text]);
      frag.insert(0, [paragraph]);
    });

    // Change reflected in serialized output
    const note = collection.get('note-1');
    expect(note?.content.content?.[0].content?.[0].text).toBe('Direct edit');
  });

  it('works with multiple XmlFragment fields in same document', () => {
    interface RichNote {
      id: string;
      title: string;
      body: XmlFragmentJSON;
      summary: XmlFragmentJSON;
    }

    const collection = createRichTextCollection<RichNote>('notes');

    collection.insert({
      id: 'note-1',
      title: 'Multi-Fragment',
      body: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Body content' }] },
      ]),
      summary: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Summary' }] },
      ]),
    });

    const note = collection.get('note-1');
    expect(note?.body.content?.[0].content?.[0].text).toBe('Body content');
    expect(note?.summary.content?.[0].content?.[0].text).toBe('Summary');

    // Update only body
    collection.update('note-1', {
      body: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Updated body' }] },
      ]),
    });

    const updated = collection.get('note-1');
    expect(updated?.body.content?.[0].content?.[0].text).toBe('Updated body');
    expect(updated?.summary.content?.[0].content?.[0].text).toBe('Summary'); // Unchanged
  });

  it('deletes document with XmlFragment fields', () => {
    const collection = createRichTextCollection<Note>('notes');

    collection.insert({
      id: 'note-1',
      title: 'To Delete',
      content: proseMirrorDoc([
        { type: 'paragraph', content: [{ type: 'text', text: 'Content' }] },
      ]),
    });

    expect(collection.get('note-1')).not.toBeNull();
    collection.delete('note-1');
    expect(collection.get('note-1')).toBeNull();
  });

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
