import { describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  isSearchCursor,
  searchFingerprint,
} from "../../functions/shared/pagination";

describe("cursor encoding", () => {
  it("round-trips arbitrary JSON payloads", () => {
    const payload = { offset: 10, fingerprint: "abc123", nested: { key: "value" } };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it("produces URL-safe output", () => {
    const cursor = encodeCursor({ name: { S: "Chili & Lime ~ Tacos?" } });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns undefined for garbage input instead of throwing", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor(encodeCursor("just a string").slice(4))).toBeUndefined();
  });
});

describe("search cursors", () => {
  it("binds the fingerprint to both query and cuisine", () => {
    const base = searchFingerprint("spicy stew", undefined);
    expect(searchFingerprint("spicy stew", undefined)).toBe(base);
    expect(searchFingerprint("spicy stew", "mexican")).not.toBe(base);
    expect(searchFingerprint("mild stew", undefined)).not.toBe(base);
  });

  it("accepts only well-formed cursor shapes", () => {
    expect(isSearchCursor({ offset: 5, fingerprint: "abc" })).toBe(true);
    expect(isSearchCursor({ offset: 0, fingerprint: "" })).toBe(true);
    expect(isSearchCursor({ offset: -1, fingerprint: "abc" })).toBe(false);
    expect(isSearchCursor({ offset: 1.5, fingerprint: "abc" })).toBe(false);
    expect(isSearchCursor({ offset: 5 })).toBe(false);
    expect(isSearchCursor("cursor")).toBe(false);
    expect(isSearchCursor(null)).toBe(false);
  });
});
