// Batch entrypoint for the Fargate scanner task.
// Reads code from S3 (INPUT_BUCKET, INPUT_PREFIX), runs scanDirectory(),
// writes results JSON to S3 (OUTPUT_BUCKET, OUTPUT_KEY), updates DynamoDB
// job record (JOB_ID), and exits 0 on success / non-zero on failure.
//
// TODO (Person 1, Week 1): implement.
