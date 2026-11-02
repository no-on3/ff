import { useEffect, useState } from 'react';
import { FunctionAlias, FunctionVersion, qualifierChoices } from '../lib/versions';
import { aliasesApi, versionsApi } from '../services/api';

/**
 * What a schedule or a queue reader of the function may run, read while its
 * form is open: undefined until the versions and the aliases are read, or when
 * they can't be, the form then leaving what it runs as it is.
 */
export function useQualifierChoices(functionId: string, open: boolean, current: string): Array<{ value: string; label: string }> | undefined {
  const [listed, setListed] = useState<{ versions: FunctionVersion[]; aliases: FunctionAlias[] } | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all([versionsApi.list(functionId), aliasesApi.list(functionId)])
      .then(([versions, aliases]) => live && setListed({ versions: versions.data, aliases: aliases.data }))
      .catch(() => live && setListed(undefined));
    return () => {
      live = false;
    };
  }, [functionId, open]);
  return listed && qualifierChoices(listed.versions, listed.aliases, current);
}
