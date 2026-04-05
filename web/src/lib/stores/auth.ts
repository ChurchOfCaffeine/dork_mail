import { writable, derived } from "svelte/store";

interface AuthState {
  token: string | null;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

function createAuthStore() {
  const initial: AuthState = {
    token: typeof localStorage !== "undefined" ? localStorage.getItem("token") : null,
    email: typeof localStorage !== "undefined" ? localStorage.getItem("userEmail") : null,
    displayName: typeof localStorage !== "undefined" ? localStorage.getItem("displayName") : null,
    isAdmin: typeof localStorage !== "undefined" ? localStorage.getItem("isAdmin") === "true" : false,
  };

  const { subscribe, set, update } = writable<AuthState>(initial);

  return {
    subscribe,
    login(token: string, email: string, displayName: string, isAdmin: boolean) {
      localStorage.setItem("token", token);
      localStorage.setItem("userEmail", email);
      localStorage.setItem("displayName", displayName);
      localStorage.setItem("isAdmin", String(isAdmin));
      set({ token, email, displayName, isAdmin });
    },
    updateDisplayName(displayName: string) {
      localStorage.setItem("displayName", displayName);
      update(s => ({ ...s, displayName }));
    },
    logout() {
      localStorage.removeItem("token");
      localStorage.removeItem("userEmail");
      localStorage.removeItem("displayName");
      localStorage.removeItem("isAdmin");
      set({ token: null, email: null, displayName: null, isAdmin: false });
    },
  };
}

export const auth = createAuthStore();
export const isAuthenticated = derived(auth, ($auth) => !!$auth.token);
