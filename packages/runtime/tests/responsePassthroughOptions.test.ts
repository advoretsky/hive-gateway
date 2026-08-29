import { describe, expect, it, vi } from 'vitest';
import {
  normalizeOptions,
  type PassthroughGatePayload,
} from '../src/plugins/response-passthrough/options';

const payload = (
  overrides: Partial<PassthroughGatePayload> = {},
): PassthroughGatePayload => ({
  subgraphName: 'products',
  typeName: 'Query',
  fieldName: 'products',
  ...overrides,
});

describe('normalizeOptions', () => {
  describe('enabled', () => {
    it('defaults to enabled', () => {
      expect(normalizeOptions().isEnabled(payload())).toBe(true);
      expect(normalizeOptions({}).isEnabled(payload())).toBe(true);
    });

    it('honours a boolean', () => {
      expect(normalizeOptions({ enabled: true }).isEnabled(payload())).toBe(
        true,
      );
      expect(normalizeOptions({ enabled: false }).isEnabled(payload())).toBe(
        false,
      );
    });

    it('passes the subgraph, type, field and operation to a predicate', () => {
      const enabled = vi.fn(() => true);
      normalizeOptions({ enabled }).isEnabled(
        payload({ operationName: 'GetProducts' }),
      );
      expect(enabled).toHaveBeenCalledWith({
        subgraphName: 'products',
        typeName: 'Query',
        fieldName: 'products',
        operationName: 'GetProducts',
      });
    });

    it('supports gating by subgraph', () => {
      const { isEnabled } = normalizeOptions({
        enabled: ({ subgraphName }) => subgraphName === 'products',
      });
      expect(isEnabled(payload())).toBe(true);
      expect(isEnabled(payload({ subgraphName: 'inventory' }))).toBe(false);
    });

    it('supports an allow-list by field', () => {
      const { isEnabled } = normalizeOptions({
        enabled: ({ fieldName }) => fieldName === 'orders',
      });
      expect(isEnabled(payload({ fieldName: 'orders' }))).toBe(true);
      expect(isEnabled(payload({ fieldName: 'products' }))).toBe(false);
    });

    it('supports a deny-list by field', () => {
      const { isEnabled } = normalizeOptions({
        enabled: ({ fieldName }) => fieldName !== 'brokenThing',
      });
      expect(isEnabled(payload({ fieldName: 'products' }))).toBe(true);
      expect(isEnabled(payload({ fieldName: 'brokenThing' }))).toBe(false);
    });

    it('requires a strict true, so a truthy non-boolean does not opt in', () => {
      const { isEnabled } = normalizeOptions({
        enabled: (() => 'yes') as unknown as () => boolean,
      });
      expect(isEnabled(payload())).toBe(false);
    });

    it('treats a throwing predicate as a decline, not as consent', () => {
      const { isEnabled } = normalizeOptions({
        enabled: () => {
          throw new Error('boom');
        },
      });
      expect(() => isEnabled(payload())).not.toThrow();
      expect(isEnabled(payload())).toBe(false);
    });
  });

  describe('minBytes', () => {
    it('defaults to 0', () => {
      expect(normalizeOptions().minBytes).toBe(0);
    });

    it('honours a value', () => {
      expect(normalizeOptions({ minBytes: 32_768 }).minBytes).toBe(32_768);
    });
  });

  describe('diagnostics', () => {
    it('forwards skip reasons', () => {
      const onSkip = vi.fn();
      normalizeOptions({ onSkip }).skip('errors-present', {
        operationName: 'Q',
        subgraphName: 'products',
      });
      expect(onSkip).toHaveBeenCalledWith('errors-present', {
        operationName: 'Q',
        subgraphName: 'products',
      });
    });

    it('forwards pass-through notifications', () => {
      const onPassthrough = vi.fn();
      normalizeOptions({ onPassthrough }).passedThrough({
        operationName: 'Q',
        subgraphName: 'products',
        bytes: 1024,
      });
      expect(onPassthrough).toHaveBeenCalledWith({
        operationName: 'Q',
        subgraphName: 'products',
        bytes: 1024,
      });
    });

    it('is a no-op when no callbacks are given', () => {
      const normalized = normalizeOptions();
      expect(() => normalized.skip('not-a-query', {})).not.toThrow();
      expect(() => normalized.passedThrough({ bytes: 1 })).not.toThrow();
    });

    // An exception in an observer is a bug in the observer, never a reason to
    // fail the request being observed.
    it('swallows a throwing onSkip', () => {
      const normalized = normalizeOptions({
        onSkip() {
          throw new Error('boom');
        },
      });
      expect(() => normalized.skip('not-a-query', {})).not.toThrow();
    });

    it('swallows a throwing onPassthrough', () => {
      const normalized = normalizeOptions({
        onPassthrough() {
          throw new Error('boom');
        },
      });
      expect(() => normalized.passedThrough({ bytes: 1 })).not.toThrow();
    });
  });
});
