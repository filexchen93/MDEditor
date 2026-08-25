import { describe, expect, it } from "vitest";

import {
  createUntitledSession,
  isDirty,
  type DocumentSession,
} from "@mdeditor/document-session";

import {
  createWorkspaceState,
  findWorkspaceTabByPath,
  getActiveWorkspaceTab,
  workspaceReducer,
} from "./workspace.js";

function savedSession(id: string, path: string): DocumentSession {
  return {
    ...createUntitledSession(id),
    path,
    diskFingerprint: `fingerprint-${id}`,
  };
}

describe("workspace tabs", () => {
  it("keeps revisions independent while activating documents", () => {
    let state = createWorkspaceState(createUntitledSession("first"));
    state = workspaceReducer(state, {
      type: "add",
      session: createUntitledSession("second"),
    });
    state = workspaceReducer(state, {
      type: "edit",
      id: "second",
      text: "second draft",
    });
    state = workspaceReducer(state, { type: "activate", id: "first" });

    expect(getActiveWorkspaceTab(state).id).toBe("first");
    expect(state.tabs[0]?.session.currentRevision).toBe(0);
    expect(state.tabs[1]?.session.currentRevision).toBe(1);
    expect(isDirty(state.tabs[1]!.session)).toBe(true);
  });

  it("records a completed save against the revision that was written", () => {
    let state = createWorkspaceState(createUntitledSession("draft"));
    state = workspaceReducer(state, {
      type: "edit",
      id: "draft",
      text: "first",
    });
    const revision = getActiveWorkspaceTab(state).session.currentRevision;
    state = workspaceReducer(state, {
      type: "edit",
      id: "draft",
      text: "first plus concurrent edit",
    });
    state = workspaceReducer(state, {
      type: "save",
      id: "draft",
      path: "C:\\notes\\draft.md",
      diskFingerprint: "saved-fingerprint",
      revision,
    });

    const session = getActiveWorkspaceTab(state).session;
    expect(session.savedRevision).toBe(1);
    expect(session.currentRevision).toBe(2);
    expect(isDirty(session)).toBe(true);
  });

  it("selects a neighboring tab when closing and finds open paths", () => {
    let state = createWorkspaceState(savedSession("one", "C:\\notes\\one.md"));
    state = workspaceReducer(state, {
      type: "add",
      session: savedSession("two", "C:\\notes\\two.md"),
    });
    state = workspaceReducer(state, {
      type: "add",
      session: savedSession("three", "C:\\notes\\three.md"),
    });
    state = workspaceReducer(state, { type: "activate", id: "two" });
    state = workspaceReducer(state, { type: "close", id: "two" });

    expect(state.tabs.map(({ id }) => id)).toEqual(["one", "three"]);
    expect(state.activeId).toBe("three");
    expect(findWorkspaceTabByPath(state, "C:\\notes\\one.md")?.id).toBe("one");
  });

  it("restores an ordered group of sessions with the requested active tab", () => {
    const first = createUntitledSession("restored-one");
    const second = createUntitledSession("restored-two");
    const state = workspaceReducer(createWorkspaceState(first), {
      type: "replaceAll",
      sessions: [first, second],
      activeId: second.id,
    });

    expect(state.tabs.map(({ id }) => id)).toEqual([
      "restored-one",
      "restored-two",
    ]);
    expect(state.activeId).toBe("restored-two");
  });
});
