export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; run: () => void };
}

let nextId = 1;
const state = $state<{ toasts: Toast[] }>({ toasts: [] });
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const toasts = {
  get list() { return state.toasts; },

  show(message: string, opts: { kind?: Toast["kind"]; action?: Toast["action"]; duration?: number } = {}) {
    const toast: Toast = { id: nextId++, message, kind: opts.kind ?? "info", action: opts.action };
    // One toast at a time reads better on a phone; a newer one replaces the old.
    state.toasts.forEach(t => this.dismiss(t.id));
    state.toasts = [toast];
    timers.set(toast.id, setTimeout(() => this.dismiss(toast.id), opts.duration ?? (opts.action ? 6000 : 3500)));
    return toast.id;
  },

  error(message: string) {
    return this.show(message, { kind: "error", duration: 5000 });
  },

  dismiss(id: number) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    state.toasts = state.toasts.filter(t => t.id !== id);
  },
};
