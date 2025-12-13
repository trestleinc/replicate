/**
 * Unit tests for Y.XmlFragment support
 *
 * Tests the core XmlFragment operations for the merge.ts API.
 * Focuses on meaningful behavior tests rather than shallow property checks.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyUpdate,
  transactWithDelta,
  fragmentToJSON,
  fragmentFromJSON,
  extractItem,
  isProseMirrorDoc,
} from '$/client/merge.js';
import type { XmlFragmentJSON } from '$/shared/types.js';
import { createTestDoc, syncDocs } from '../utils/yjs.js';

describe('Y.XmlFragment support', () => {
  describe('JSON serialization', () => {
    it('round-trips complex document through JSON', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('test');

      // Build a complex document structure
      doc.transact(() => {
        // Paragraph with formatted text
        const paragraph = new Y.XmlElement('paragraph');
        const boldText = new Y.XmlText();
        boldText.insert(0, 'Bold', { bold: true });
        const normalText = new Y.XmlText();
        normalText.insert(0, ' and normal');
        paragraph.insert(0, [boldText, normalText]);
        fragment.insert(0, [paragraph]);

        // Nested list
        const list = new Y.XmlElement('bulletList');
        const item = new Y.XmlElement('listItem');
        const itemPara = new Y.XmlElement('paragraph');
        const itemText = new Y.XmlText();
        itemText.insert(0, 'List item');
        itemPara.insert(0, [itemText]);
        item.insert(0, [itemPara]);
        list.insert(0, [item]);
        fragment.insert(1, [list]);
      });

      // Convert to JSON
      const json = fragmentToJSON(fragment);

      // Verify structure
      expect(json.type).toBe('doc');
      expect(json.content).toHaveLength(2);
      expect(json.content?.[0].type).toBe('paragraph');
      expect(json.content?.[0].content?.[0].marks?.[0].type).toBe('bold');
      expect(json.content?.[1].type).toBe('bulletList');

      // Round-trip to new fragment
      const doc2 = new Y.Doc();
      const fragment2 = doc2.getXmlFragment('test');
      doc2.transact(() => {
        fragmentFromJSON(fragment2, json);
      });

      // Verify identical JSON output
      expect(fragmentToJSON(fragment2)).toEqual(json);
    });

    it('handles empty fragment', () => {
      const fragment = new Y.XmlFragment();
      const json = fragmentToJSON(fragment);

      expect(json.type).toBe('doc');
      expect(json.content).toHaveLength(1);
      expect(json.content?.[0].type).toBe('paragraph');
    });
  });

  describe('isProseMirrorDoc detection', () => {
    it('detects ProseMirror doc structure correctly', () => {
      const validDoc: XmlFragmentJSON = {
        type: 'doc',
        content: [{ type: 'paragraph' }],
      };
      expect(isProseMirrorDoc(validDoc)).toBe(true);

      const emptyDoc: XmlFragmentJSON = { type: 'doc' };
      expect(isProseMirrorDoc(emptyDoc)).toBe(true);

      // Non-docs
      expect(isProseMirrorDoc(null)).toBe(false);
      expect(isProseMirrorDoc({})).toBe(false);
      expect(isProseMirrorDoc({ type: 'paragraph' })).toBe(false);
      expect(isProseMirrorDoc('string')).toBe(false);
      expect(isProseMirrorDoc(123)).toBe(false);
    });
  });

  describe('extractItem with fragments', () => {
    it('extracts mixed field types with serialized fragments', () => {
      const doc = createTestDoc(1);
      const ymap = doc.getMap<unknown>('test');

      doc.transact(() => {
        const itemMap = new Y.Map();
        itemMap.set('id', 'doc-1');
        itemMap.set('title', 'Test Doc');
        itemMap.set('count', 42);
        itemMap.set('tags', ['a', 'b']);

        // Add XmlFragment field
        const fragment = new Y.XmlFragment();
        const paragraph = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Rich content');
        paragraph.insert(0, [text]);
        fragment.insert(0, [paragraph]);
        itemMap.set('content', fragment);

        ymap.set('doc-1', itemMap);
      });

      const result = extractItem<{
        id: string;
        title: string;
        count: number;
        tags: string[];
        content: XmlFragmentJSON;
      }>(ymap, 'doc-1');

      // Primitives extracted correctly
      expect(result?.id).toBe('doc-1');
      expect(result?.title).toBe('Test Doc');
      expect(result?.count).toBe(42);
      expect(result?.tags).toEqual(['a', 'b']);

      // XmlFragment serialized to JSON
      expect(result?.content.type).toBe('doc');
      expect(result?.content.content?.[0].content?.[0].text).toBe('Rich content');
    });

    it('returns null for non-existent document', () => {
      const doc = createTestDoc(1);
      const ymap = doc.getMap<unknown>('test');

      expect(extractItem(ymap, 'non-existent')).toBeNull();
    });
  });

  describe('getFragmentFromYMap', () => {
    it('gets live fragment reference for editor binding', () => {
      const doc = createTestDoc(1);
      const ymap = doc.getMap<unknown>('test');

      doc.transact(() => {
        const itemMap = new Y.Map();
        itemMap.set('id', 'doc-1');
        const fragment = new Y.XmlFragment();
        itemMap.set('content', fragment);
        ymap.set('doc-1', itemMap);
      });

      const itemMap = ymap.get('doc-1') as Y.Map<unknown>;
      const fragment = itemMap.get('content');
      expect(fragment).toBeInstanceOf(Y.XmlFragment);
    });
  });

  describe('CRDT delta operations', () => {
    it('captures XmlFragment changes in delta and syncs between docs', () => {
      const doc1 = createTestDoc(1);
      const doc2 = createTestDoc(2);
      const ymap1 = doc1.getMap<unknown>('test');

      // Create initial document with fragment
      const { delta: createDelta } = transactWithDelta(doc1, () => {
        const itemMap = new Y.Map();
        itemMap.set('id', 'doc-1');
        itemMap.set('title', 'Initial');
        const fragment = new Y.XmlFragment();
        itemMap.set('content', fragment);
        ymap1.set('doc-1', itemMap);
      });

      // Apply creation delta to doc2
      applyUpdate(doc2, createDelta);
      syncDocs(doc1, doc2);

      // Modify fragment on doc1
      const { delta: editDelta } = transactWithDelta(doc1, () => {
        const itemMap = ymap1.get('doc-1') as Y.Map<unknown>;
        const fragment = itemMap.get('content') as Y.XmlFragment;
        const paragraph = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'New content');
        paragraph.insert(0, [text]);
        fragment.insert(0, [paragraph]);
      });

      // Apply edit delta to doc2
      applyUpdate(doc2, editDelta);

      // Verify both docs have the same content
      const ymap2 = doc2.getMap<unknown>('test');
      const result1 = extractItem<{ content: XmlFragmentJSON }>(ymap1, 'doc-1');
      const result2 = extractItem<{ content: XmlFragmentJSON }>(ymap2, 'doc-1');

      expect(result1?.content).toEqual(result2?.content);
      expect(result2?.content.content?.[0].content?.[0].text).toBe('New content');
    });

    it('merges concurrent XmlFragment edits from multiple clients', () => {
      const doc1 = createTestDoc(1);
      const doc2 = createTestDoc(2);

      // Create shared initial state
      const ymap1 = doc1.getMap<unknown>('test');
      doc1.transact(() => {
        const itemMap = new Y.Map();
        itemMap.set('id', 'doc-1');
        const fragment = new Y.XmlFragment();
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, 'Hello');
        para.insert(0, [text]);
        fragment.insert(0, [para]);
        itemMap.set('content', fragment);
        ymap1.set('doc-1', itemMap);
      });

      syncDocs(doc1, doc2);
      const ymap2 = doc2.getMap<unknown>('test');

      // Client 1: Insert at beginning
      doc1.transact(() => {
        const itemMap = ymap1.get('doc-1') as Y.Map<unknown>;
        const fragment = itemMap.get('content') as Y.XmlFragment;
        const para = fragment.get(0) as Y.XmlElement;
        const text = para.get(0) as Y.XmlText;
        text.insert(0, 'Start: ');
      });

      // Client 2: Insert at end (concurrent, no sync yet)
      doc2.transact(() => {
        const itemMap = ymap2.get('doc-1') as Y.Map<unknown>;
        const fragment = itemMap.get('content') as Y.XmlFragment;
        const para = fragment.get(0) as Y.XmlElement;
        const text = para.get(0) as Y.XmlText;
        text.insert(text.length, ' :End');
      });

      // Sync both docs
      syncDocs(doc1, doc2);

      // Both edits should be preserved
      const result1 = extractItem<{ content: XmlFragmentJSON }>(ymap1, 'doc-1');
      const result2 = extractItem<{ content: XmlFragmentJSON }>(ymap2, 'doc-1');

      // Convergence: both docs have identical content
      expect(result1?.content).toEqual(result2?.content);

      // Both edits merged
      const mergedText = result1?.content.content?.[0].content?.[0].text;
      expect(mergedText).toBe('Start: Hello :End');
    });
  });
});
