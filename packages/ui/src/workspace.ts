import {
  recordEdit,
  recordSave,
  type DocumentSession,
} from "@mdeditor/document-session";

export interface WorkspaceTab {
  readonly id: string;
  readonly session: DocumentSession;
}

export interface WorkspaceState {
  readonly activeId: string;
  readonly tabs: readonly WorkspaceTab[];
}

export type WorkspaceAction =
  | { readonly type: "activate"; readonly id: string }
  | { readonly type: "add"; readonly session: DocumentSession }
  | { readonly type: "replace"; readonly session: DocumentSession }
  | {
      readonly type: "replaceAll";
      readonly sessions: readonly DocumentSession[];
      readonly activeId: string;
    }
  | { readonly type: "edit"; readonly id: string; readonly text: string }
  | {
      readonly type: "save";
      readonly id: string;
      readonly path: string;
      readonly diskFingerprint: string;
      readonly revision: number;
    }
  | { readonly type: "close"; readonly id: string };

export function createWorkspaceState(session: DocumentSession): WorkspaceState {
  return { activeId: session.id, tabs: [{ id: session.id, session }] };
}

export function getActiveWorkspaceTab(state: WorkspaceState): WorkspaceTab {
  const tab = state.tabs.find(({ id }) => id === state.activeId);
  if (tab === undefined) throw new Error("Workspace has no active tab");
  return tab;
}

export function findWorkspaceTabByPath(
  state: WorkspaceState,
  path: string,
): WorkspaceTab | undefined {
  return state.tabs.find((tab) => tab.session.path === path);
}

function updateTab(
  state: WorkspaceState,
  id: string,
  update: (tab: WorkspaceTab) => WorkspaceTab,
): WorkspaceState {
  let found = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    found = true;
    return update(tab);
  });
  return found ? { ...state, tabs } : state;
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "activate":
      return state.tabs.some(({ id }) => id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case "add":
      return state.tabs.some(({ id }) => id === action.session.id)
        ? { ...state, activeId: action.session.id }
        : {
            activeId: action.session.id,
            tabs: [
              ...state.tabs,
              { id: action.session.id, session: action.session },
            ],
          };
    case "replace":
      return createWorkspaceState(action.session);
    case "replaceAll":
      return action.sessions.length > 0 &&
        action.sessions.some(({ id }) => id === action.activeId)
        ? {
            activeId: action.activeId,
            tabs: action.sessions.map((session) => ({
              id: session.id,
              session,
            })),
          }
        : state;
    case "edit":
      return updateTab(state, action.id, (tab) => ({
        ...tab,
        session: recordEdit(tab.session, action.text),
      }));
    case "save":
      return updateTab(state, action.id, (tab) => ({
        ...tab,
        session: recordSave(
          tab.session,
          action.diskFingerprint,
          action.path,
          action.revision,
        ),
      }));
    case "close": {
      if (state.tabs.length <= 1) return state;
      const index = state.tabs.findIndex(({ id }) => id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter(({ id }) => id !== action.id);
      if (state.activeId !== action.id) return { ...state, tabs };
      const nextActive = tabs[Math.min(index, tabs.length - 1)];
      if (nextActive === undefined) return state;
      return { activeId: nextActive.id, tabs };
    }
  }
}
