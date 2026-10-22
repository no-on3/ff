import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alarm, alarmsApi } from '../services/api';
import { StateBadge } from './Alarms';
import { Panel } from './Panel';

/** A function's alarms on its page: each one's state and name, and where to set them. */
const FunctionAlarms: React.FC<{ functionId: string; mayChange: boolean }> = ({ functionId, mayChange }) => {
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);

  useEffect(() => {
    alarmsApi
      .list()
      .then(({ data }) => setAlarms(data.filter((alarm) => alarm.functionId === functionId)))
      .catch(() => setAlarms(null));
  }, [functionId]);

  if (alarms === null) return null;
  return (
    <Panel
      aria-label="Alarms"
      title="Alarms"
      actions={
        mayChange && (
          <Link to={`/alarms?function=${functionId}`} className="text-[13px]">
            Add one
          </Link>
        )
      }
    >
      {alarms.length === 0 ? (
        <p className="text-[13px] text-gray-600">None watches this function.</p>
      ) : (
        <ul className="space-y-2.5">
          {alarms.map((alarm) => (
            <li key={alarm.id} data-alarm={alarm.id} className="flex items-center gap-2 text-[13px]">
              <StateBadge state={alarm.state} /> <span className="min-w-0 truncate text-gray-800">{alarm.name}</span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/alarms" className="mt-3 inline-block text-[13px]">
        All alarms
      </Link>
    </Panel>
  );
};

export default FunctionAlarms;
