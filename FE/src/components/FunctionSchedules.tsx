import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, TextField, Typography } from '@mui/material';
import { EXPRESSION_EXAMPLES, Schedule, ScheduleForm, emptyForm, formOf, lastRunText, nextRunText, scheduleOf } from '../lib/schedules';
import { apiErrorMessage } from '../lib/functions';
import { Function, schedulesApi } from '../services/api';

interface FunctionSchedulesProps {
  func: Function;
  mayChange: boolean;
}

/** A time, as the console shows times, and in UTC, as schedules count them: a rate's runs keep the second it was started at. */
const when = (iso: string) => `${new Date(iso).toLocaleString()} (${iso.slice(11, 19)} UTC)`;

/**
 * A function's schedules, as SAM's Schedule events: each runs the function at
 * the times its EventBridge expression names, in UTC, with the Scheduled Event
 * or an input of its own. The form shows the next runs as the expression is
 * typed. Owners and developers change them; every member sees them.
 */
export const FunctionSchedules: React.FC<FunctionSchedulesProps> = ({ func, mayChange }) => {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  /** The schedule being changed, null for a new one; undefined while no form is open. */
  const [editing, setEditing] = useState<Schedule | null | undefined>(undefined);
  const [form, setForm] = useState<ScheduleForm>(emptyForm());
  const [preview, setPreview] = useState<{ runs: string[] } | { problem: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    schedulesApi
      .list(func.id)
      .then(({ data }) => current && setSchedules(data))
      .catch((err: unknown) => current && setError(apiErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [func.id]);

  // The next runs, as the expression is typed: the API's own parser says, and what is wrong.
  useEffect(() => {
    if (editing === undefined || form.expression.trim() === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      schedulesApi
        .nextRuns(form.expression.trim())
        .then(({ data }) => current && setPreview({ runs: data.runs }))
        .catch((err: unknown) => current && setPreview({ problem: apiErrorMessage(err) }));
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [editing, form.expression]);

  const open = (schedule: Schedule | null) => {
    setEditing(schedule);
    setForm(schedule ? formOf(schedule) : emptyForm());
    setPreview(null);
    setError(null);
  };

  const replace = (schedule: Schedule) =>
    setSchedules((all) => [...(all ?? []).filter((s) => s.id !== schedule.id), schedule].sort((a, b) => a.name.localeCompare(b.name)));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const checked = scheduleOf(form);
    if ('problem' in checked) {
      setError(checked.problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = editing ? await schedulesApi.update(func.id, editing.id, checked.body) : await schedulesApi.create(func.id, checked.body);
      replace(data);
      setEditing(undefined);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (schedule: Schedule) => {
    setBusy(true);
    setError(null);
    try {
      replace((await schedulesApi.update(func.id, schedule.id, { enabled: !schedule.enabled })).data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (schedule: Schedule) => {
    if (!window.confirm(`Delete the schedule ${schedule.name}? It runs no more.`)) return;
    setBusy(true);
    setError(null);
    try {
      await schedulesApi.remove(func.id, schedule.id);
      setSchedules((all) => (all ?? []).filter((s) => s.id !== schedule.id));
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const formCard = (
    <form onSubmit={save}>
      <Box sx={{ display: 'grid', gap: 2, mt: 2 }}>
        <TextField
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          helperText="Unique within the function: letters, digits, '.', '-' and '_'"
          slotProps={{ htmlInput: { spellCheck: false, maxLength: 64 } }}
        />
        <TextField
          label="Expression"
          value={form.expression}
          onChange={(e) => setForm({ ...form, expression: e.target.value })}
          helperText="EventBridge's, in UTC: rate(5 minutes), rate(1 hour)… or cron(minutes hours day-of-month month day-of-week year), one of the two days ?"
          slotProps={{ htmlInput: { spellCheck: false } }}
        />
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {EXPRESSION_EXAMPLES.map((example) => (
            <Chip key={example} label={example} size="small" onClick={() => setForm({ ...form, expression: example })} />
          ))}
        </Box>
        {preview &&
          form.expression.trim() !== '' &&
          ('problem' in preview ? (
            <Alert severity="warning">{preview.problem}</Alert>
          ) : (
            <Box>
              <Typography variant="body2" color="text.secondary">
                Its next runs:
              </Typography>
              <Typography component="ul" variant="body2" sx={{ m: 0, pl: 3 }}>
                {preview.runs.map((run) => (
                  <li key={run}>{when(run)}</li>
                ))}
              </Typography>
            </Box>
          ))}
        <TextField
          label="Input (optional)"
          value={form.input}
          onChange={(e) => setForm({ ...form, input: e.target.value })}
          multiline
          minRows={2}
          helperText="The function's event, any JSON value; empty sends EventBridge's Scheduled Event"
          slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: 'monospace' } } }}
        />
        <TextField label="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormControlLabel control={<Checkbox checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />} label="Enabled" />
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button type="submit" variant="contained" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create schedule'}
          </Button>
          <Button disabled={busy} onClick={() => setEditing(undefined)}>
            Cancel
          </Button>
        </Box>
      </Box>
    </form>
  );

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Schedules
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Run this function at set times, as an EventBridge rule&apos;s schedule does: each run calls it with the Scheduled Event, or an input of
          your own, as a call like any other. A run happens at most once, isn&apos;t retried, and is in the Invocations tab.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}

        {func.eventFormat === 'wrapped' ? (
          <Alert severity="info" sx={{ my: 2 }}>
            A schedule sends EventBridge&apos;s Scheduled Event, as AWS Lambda passes it, and this function takes FF&apos;s original one, with the
            input in event.body. Move it to AWS Lambda&apos;s event first, in Overview.
          </Alert>
        ) : schedules === null ? (
          <Typography variant="body2" sx={{ my: 2 }}>
            Loading…
          </Typography>
        ) : (
          <>
            {schedules.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
                No schedule yet.
              </Typography>
            ) : (
              schedules.map((schedule) => (
                <Box key={schedule.id} sx={{ borderTop: 1, borderColor: 'divider', py: 2 }}>
                  <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 500 }}>{schedule.name}</Typography>
                    <Typography sx={{ fontFamily: 'monospace' }}>{schedule.expression}</Typography>
                    <Chip size="small" label={schedule.enabled ? 'Enabled' : 'Disabled'} color={schedule.enabled ? 'success' : 'default'} />
                    {mayChange && (
                      <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
                        <Button size="small" disabled={busy} onClick={() => void toggle(schedule)}>
                          {schedule.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        <Button size="small" variant="outlined" disabled={busy} onClick={() => open(schedule)}>
                          Change
                        </Button>
                        <Button size="small" color="error" disabled={busy} onClick={() => void remove(schedule)}>
                          Delete
                        </Button>
                      </Box>
                    )}
                  </Box>
                  {schedule.description && (
                    <Typography variant="body2" color="text.secondary">
                      {schedule.description}
                    </Typography>
                  )}
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    Next run: {nextRunText(schedule, when)}
                  </Typography>
                  <Typography variant="body2">
                    Last run: {lastRunText(schedule, when)}
                    {schedule.lastRequestId && schedule.lastOutcome !== 'running' && !schedule.lastOutcome?.startsWith('skipped') && (
                      <span style={{ fontFamily: 'monospace' }}> · {schedule.lastRequestId}</span>
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Event: {schedule.input === null ? "EventBridge's Scheduled Event" : 'its own input'}
                  </Typography>
                </Box>
              ))
            )}
            {mayChange ? (
              editing !== undefined ? (
                formCard
              ) : (
                <Button variant="contained" sx={{ mt: 2 }} onClick={() => open(null)}>
                  New schedule
                </Button>
              )
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                As a viewer, you see the schedules; owners and developers make and change them.
              </Typography>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
