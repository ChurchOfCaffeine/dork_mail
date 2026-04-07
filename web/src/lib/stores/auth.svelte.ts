interface AuthState {
  token: string | null;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

/** Decode JWT payload without verifying signature — server always re-verifies */
function jwtIsAdmin(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded.isAdmin === true;
  } catch {
    return false;
  }
}

function getInitial(): AuthState {
  if (typeof localStorage === "undefined") {
    return { token: null, email: null, displayName: null, isAdmin: false };
  }
  const token = localStorage.getItem("token");
  return {
    token,
    email: localStorage.getItem("userEmail"),
    displayName: localStorage.getItem("displayName"),
    isAdmin: token ? jwtIsAdmin(token) : false,
  };
}

const _state = $state<AuthState>(getInitial());

export const auth = {
  get token()           { return _state.token; },
  get email()           { return _state.email; },
  get displayName()     { return _state.displayName; },
  get isAdmin()         { return _state.isAdmin; },
  get isAuthenticated() { return !!_state.token; },

  login(token: string, email: string, displayName: string, isAdmin: boolean) {
    localStorage.setItem("token", token);
    localStorage.setItem("userEmail", email);
    localStorage.setItem("displayName", displayName);
    _state.token = token;
    _state.email = email;
    _state.displayName = displayName;
    _state.isAdmin = isAdmin;
  },

  updateDisplayName(displayName: string) {
    localStorage.setItem("displayName", displayName);
    _state.displayName = displayName;
  },

  logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("userEmail");
    localStorage.removeItem("displayName");
    _state.token = null;
    _state.email = null;
    _state.displayName = null;
    _state.isAdmin = false;
  },
};
