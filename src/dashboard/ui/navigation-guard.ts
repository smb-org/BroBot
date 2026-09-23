export type DashboardNavigationGuard = (proceed: () => void, cancel: () => void) => void;

const navigationGuards = new Set<DashboardNavigationGuard>();

export const registerDashboardNavigationGuard = (guard: DashboardNavigationGuard): (() => void) => {
  navigationGuards.add(guard);
  return () => { navigationGuards.delete(guard); };
};

export const runDashboardNavigationGuards = (proceed: () => void, cancel: () => void): void => {
  const guards = [...navigationGuards];
  const runNext = (index: number): void => {
    const guard = guards[index];
    if (guard === undefined) {
      proceed();
      return;
    }
    guard(() => { runNext(index + 1); }, cancel);
  };
  runNext(0);
};
