/**
 * Kept in memory only. Bulwark seals its own tokens so a script reading web storage on this
 * origin finds nothing usable, and the layout trades the session cookie for a fresh token on every load.
 */
interface AuthState {
  token: string | null;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

const _state = $state<AuthState>({ token: null, email: null, displayName: null, isAdmin: false });

export const auth = {
  get token()           { return _state.token; },
  get email()           { return _state.email; },
  get displayName()     { return _state.displayName; },
  get isAdmin()         { return _state.isAdmin; },
  get isAuthenticated() { return !!_state.token; },

  login(token: string, email: string, displayName: string, isAdmin: boolean) {
    _state.token = token;
    _state.email = email;
    _state.displayName = displayName;
    _state.isAdmin = isAdmin;
  },

  logout() {
    _state.token = null;
    _state.email = null;
    _state.displayName = null;
    _state.isAdmin = false;
  },
};
