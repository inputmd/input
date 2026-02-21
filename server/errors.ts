export class ClientError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ClientError';
    this.statusCode = statusCode;
  }
}
