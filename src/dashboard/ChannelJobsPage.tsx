import { Fragment, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { CHANNEL_JOB_ERROR_TEXTS } from "../contracts/channel-jobs";
import type { PanelChannelJob } from "../panel-contract";
import { fetchChannelJobs, pauseChannelJob, resumeChannelJob, runChannelJobNow } from "./api";
import { dashboardLanguage, dashboardTexts } from "./locale";
import { Button, EmptyState, Section, SettingsPage, StatusLed, notify } from "./ui";
import { queryKeys } from "./data/keys";

import "./ChannelJobsPage.css";

const formatJobTime = (timestamp: number | null, language: "de" | "en", never: string): string => {
  if (timestamp === null) return never;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
};

const ledState = (state: PanelChannelJob["state"]): "ok" | "loading" | "warn" | "error" =>
  state === "idle" ? "ok" : state === "running" ? "loading" : state === "paused" ? "warn" : "error";

const ChannelJobCard = ({
  job,
  busy,
  onAction,
}: {
  job: PanelChannelJob;
  busy: boolean;
  onAction: (jobId: string, action: "run" | "pause" | "resume") => void;
}): ReactElement => {
  const language = dashboardLanguage();
  const labels = dashboardTexts().channelJobs;
  const errorText = job.errorTextKey === null ? null : CHANNEL_JOB_ERROR_TEXTS[language][job.errorTextKey];
  const requiredScopes = job.requiredScopes.length === 0
    ? "—"
    : job.requiredScopes.map((scope, index) => <Fragment key={scope}>
      {index > 0 ? ", " : null}<span className="channel-jobs-card__scope">{scope}</span>
    </Fragment>);
  const alternativeScopes = job.requiredScopeAlternatives?.map((group, groupIndex) => <Fragment key={`alternative-${String(groupIndex)}`}>
    {job.requiredScopes.length > 0 || groupIndex > 0 ? ", " : null}
    {group.map((scope, index) => <Fragment key={scope}>{index > 0 ? " or " : null}<span className="channel-jobs-card__scope">{scope}</span></Fragment>)}
  </Fragment>);
  const nextRun = job.nextRunAt !== null
    ? formatJobTime(job.nextRunAt, language, labels.never)
    : job.state === "paused"
      ? labels.states.paused
      : job.state === "running"
        ? labels.afterCurrentRun
        : labels.never;

  return <article className="channel-jobs-card" data-state={job.state}>
    <header className="channel-jobs-card__header">
      <div className="channel-jobs-card__title">
        <h3>{job.label[language]}</h3>
        <StatusLed state={ledState(job.state)} label={labels.states[job.state]} />
      </div>
      <div className="channel-jobs-card__actions">
        <Button size="compact" variant="primary" icon="player-play" disabled={busy || job.state === "paused"} onClick={() => { onAction(job.id, "run"); }}>{labels.runNow}</Button>
        {job.state === "paused"
          ? <Button size="compact" variant="neutral" icon="player-play" disabled={busy} onClick={() => { onAction(job.id, "resume"); }}>{labels.resume}</Button>
          : <Button size="compact" variant="neutral" icon="player-pause" disabled={busy} onClick={() => { onAction(job.id, "pause"); }}>{labels.pause}</Button>}
      </div>
    </header>
    <dl className="channel-jobs-card__facts">
      <div><dt>{labels.lastRun}</dt><dd>{formatJobTime(job.lastStartedAt, language, labels.never)}</dd></div>
      <div><dt>{labels.lastSuccess}</dt><dd>{formatJobTime(job.lastSuccessAt, language, labels.never)}</dd></div>
      <div><dt>{labels.nextRun}</dt><dd>{nextRun}</dd></div>
      <div><dt>{labels.requiredScopes}</dt><dd>{requiredScopes}{alternativeScopes}</dd></div>
    </dl>
    <div className="channel-jobs-card__status-slot" aria-live="polite">
      {job.state === "paused"
        ? <p className="channel-jobs-card__paused">
          {labels.pausedSince} {formatJobTime(job.pausedAt, language, labels.never)}
          {job.reconcileNeeded ? ` · ${labels.reconcileNeeded}` : ""}
        </p>
        : errorText !== null
          ? <p className="channel-jobs-card__error"><strong>{labels.error}:</strong> {errorText}</p>
          : job.resultSummary !== null
            ? <p><strong>{labels.result}:</strong> {job.resultSummary[language]}</p>
            : null}
    </div>
  </article>;
};

export function ChannelJobsPage({ channelId }: { channelId: string }): ReactElement {
  const labels = dashboardTexts().channelJobs;
  const queryClient = useQueryClient();
  const queryKey = queryKeys.channel(channelId, "jobs");
  const jobsQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => (await fetchChannelJobs(channelId, signal)).jobs,
    refetchOnWindowFocus: false,
  });
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const runAction = async (jobId: string, action: "run" | "pause" | "resume"): Promise<void> => {
    if (pendingJobId !== null) return;
    setPendingJobId(jobId);
    try {
      if (action === "run") {
        const result = await runChannelJobNow(channelId, jobId);
        notify({ tone: result.result === "already_running" ? "info" : "success", message: result.result === "already_running" ? labels.alreadyRunning : labels.runScheduled });
      } else if (action === "pause") {
        await pauseChannelJob(channelId, jobId);
        notify({ tone: "success", message: labels.pausedFeedback });
      } else {
        await resumeChannelJob(channelId, jobId);
        notify({ tone: "success", message: labels.resumedFeedback });
      }
      await queryClient.invalidateQueries({ queryKey, exact: true });
    } catch {
      notify({ tone: "error", message: labels.actionError });
    } finally {
      setPendingJobId(null);
    }
  };

  const content = jobsQuery.isPending
    ? <p className="channel-jobs-page__message" role="status">{labels.loading}</p>
    : jobsQuery.isError
      ? <div className="channel-jobs-page__load-error" role="alert"><p>{labels.loadError}</p><Button size="compact" onClick={() => { void jobsQuery.refetch(); }}>{labels.retry}</Button></div>
      : jobsQuery.data.length === 0
        ? <EmptyState title={labels.emptyTitle} description={labels.emptyDescription} />
        : <div className="channel-jobs-page__list">{jobsQuery.data.map((job) => <ChannelJobCard
          key={job.id}
          job={job}
          busy={pendingJobId !== null}
          onAction={(id, action) => { void runAction(id, action); }}
        />)}</div>;

  return <SettingsPage
    className="channel-jobs-page"
    kind="channel-jobs"
    title={labels.title}
    subtitle={labels.subtitle}
    columns={[<Section key="jobs" title={labels.sectionTitle}>{content}</Section>]}
  />;
}
