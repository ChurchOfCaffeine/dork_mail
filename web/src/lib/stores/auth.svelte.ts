interface AuthState {
  token: string | null;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

/** Decode JWT payload without verifying signature — server always re-verifies */
function decodeJwt(token: string): { isAdmin?: boolean; exp?: number } | null {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function jwtIsAdmin(token: string): boolean {
  return decodeJwt(token)?.isAdmin === true;
}

/** Check if the token is expired (client-side pre-check; server is authoritative) */
function jwtIsExpired(token: string): boolean {
  const exp = decodeJwt(token)?.exp;
  if (typeof exp !== "number") return false;
  return Date.now() >= exp * 1000;
}

function getInitial(): AuthState {
  if (typeof localStorage === "undefined") {
    return { token: null, email: null, displayName: null, isAdmin: false };
  }
  const token = localStorage.getItem("token");
  // Clear expired tokens eagerly so the UI doesn't treat us as authenticated
  if (token && jwtIsExpired(token)) {
    localStorage.removeItem("token");
    localStorage.removeItem("userEmail");
    localStorage.removeItem("displayName");
    return { token: null, email: null, displayName: null, isAdmin: false };
  }
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
    // Cached message lists, drafts and contacts belong to this user
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("dm:") && key !== "dm:theme") localStorage.removeItem(key);
    }
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
    _state.token = null;
    _state.email = null;
    _state.displayName = null;
    _state.isAdmin = false;
  },
};
