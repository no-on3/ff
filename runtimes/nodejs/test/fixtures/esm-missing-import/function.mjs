// A dependency left out of the package: the import fails when the module loads.
import client from 'ff-test-not-installed';

export const handler = async () => client.version;
