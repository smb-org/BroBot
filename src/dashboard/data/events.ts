export const dashboardAuthenticationRequiredEvent = "brobot:authentication-required";

export const dispatchDashboardAuthenticationRequired = (): void => {
  window.dispatchEvent(new Event(dashboardAuthenticationRequiredEvent));
};
