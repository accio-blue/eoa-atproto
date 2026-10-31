import { Predicate } from 'effect';
import type { Schema } from 'effect';

// Basic lexicon types
export interface LexiconDef {
  readonly type: string;
  readonly description?: string;
  readonly [key: string]: Schema.Json;
}

export interface LexiconDoc {
  readonly lexicon: number;
  readonly id: string;
  readonly defs: Record<string, LexiconDef>;
  readonly [key: string]: Schema.Json;
}

// Lexicon registry for managing multiple lexicons
export class Lexicons {
  private readonly docs = new Map<string, LexiconDoc>();

  constructor(docs: readonly LexiconDoc[] = []) {
    for (const doc of docs) {
      this.add(doc);
    }
  }

  add(doc: LexiconDoc): void {
    this.docs.set(doc.id, doc);
  }

  get(id: string): LexiconDoc | undefined {
    return this.docs.get(id);
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get all(): ReadonlyMap<string, LexiconDoc> {
    return this.docs;
  }

  get ids(): string[] {
    return Array.from(this.docs.keys());
  }
}

// Utility to create a lexicon registry from an array of docs
export const createLexicons = (docs: readonly LexiconDoc[]): Lexicons => {
  return new Lexicons(docs);
};

// Type guard for lexicon documents
export const isLexiconDoc = (value: unknown): value is LexiconDoc => {
  return (
    Predicate.isObjectOrArray(value) &&
    Predicate.hasProperty(value, 'lexicon') &&
    Predicate.hasProperty(value, 'id') &&
    Predicate.hasProperty(value, 'defs') &&
    typeof value.lexicon === 'number' &&
    typeof value.id === 'string' &&
    (value.defs === null || Predicate.isObjectOrArray(value.defs))
  );
};
