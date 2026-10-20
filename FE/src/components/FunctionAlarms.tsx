import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alarm, alarmsApi } from '../services/api';
import { StateBadge } from './Alarms';

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
    <section aria-label="Alarms" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span className="font-medium text-gray-700">Alarms</span>
      {alarms.length === 0 && <span className="text-gray-600">None.</span>}
      {alarms.map((alarm) => (
        <span key={alarm.id} data-alarm={alarm.id} className="flex items-center gap-2">
          <StateBadge state={alarm.state} /> <span>{alarm.name}</span>
        </span>
      ))}
      <Link to="/alarms">All alarms</Link>
      {mayChange && <Link to={`/alarms?function=${functionId}`}>Add one</Link>}
    </section>
  );
};

export default FunctionAlarms;
