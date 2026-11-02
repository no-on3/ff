import { useEffect, useState } from 'react';
import { FunctionAlias, FunctionVersion, qualifierChoices } from '../lib/versions';
import { aliasesApi, versionsApi } from '../services/api';

/** A function's versions and its aliases, as the forms that name one read them. */
export interface FunctionRoutes {
  versions: FunctionVersion[];
  aliases: FunctionAlias[];
}

/**
 * The function's versions and aliases, read while a function is given:
 * undefined until they are read, when they can't be, and without a function.
 */
export function useFunctionRoutes(functionId: string | undefined): FunctionRoutes | undefined {
  const [listed, setListed] = useState<FunctionRoutes | undefined>(undefined);
  useEffect(() => {
    setListed(undefined);
    if (!functionId) return;
    let live = true;
    Promise.all([versionsApi.list(functionId), aliasesApi.list(functionId)])
      .then(([versions, aliases]) => live && setListed({ versions: versions.data, aliases: aliases.data }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [functionId]);
  return listed;
}

/** Whether the function has a version or an alias, whose calls a view may keep apart. */
export const hasRoutes = (routes: FunctionRoutes | undefined): boolean => !!routes && (routes.versions.length > 0 || routes.aliases.length > 0);

/**
 * What a schedule or a queue reader of the function may run, read while its
 * form is open: undefined until the versions and the aliases are read, or when
 * they can't be, the form then leaving what it runs as it is.
 */
export function useQualifierChoices(functionId: string, open: boolean, current: string): Array<{ value: string; label: string }> | undefined {
  const listed = useFunctionRoutes(open ? functionId : undefined);
  return listed && qualifierChoices(listed.versions, listed.aliases, current);
}
