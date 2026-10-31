import ms from 'ms';

export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify({ records: event.Records?.length ?? 0, in: ms(1500) }) });
