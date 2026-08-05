export default function DataDeletion() {
  return (
    <main className="page-content" style={{ paddingTop: 40 }}>
      <article className="panel" style={{ padding: 28, maxWidth: 900, margin: '0 auto' }}>
        <h1>Request Data Deletion</h1>
        <p>We respect your privacy. Use this page to request deletion of your workspace and personal data from InboxPlease.</p>

        <h2>How to request deletion</h2>
        <ol>
          <li>Enter the email address or workspace identifier used with InboxPlease.</li>
          <li>Provide any details that help us locate your data (store name, Page ID).</li>
          <li>Submit the request — our team will process it and confirm by email.</li>
        </ol>

        <h2>For Facebook App Review (Data Deletion Callback)</h2>
        <p>
          Facebook requires apps that access user data to provide a data deletion callback URL. That URL must:
        </p>
        <ul>
          <li>Accept a GET request for verification: respond with HTTP 200 and echo back the provided challenge parameter (e.g. <code>hub.challenge</code>), or follow Facebook's verification flow.</li>
          <li>Accept a POST from Facebook when a deletion is requested. The POST payload will identify the user to delete.
            Your server should delete the user's data and respond with a confirmation JSON object as described by Facebook.
          </li>
        </ul>
        <p>
          Example callback URLs you can provide to Facebook App Settings (replace with your deployed domain):
        </p>
        <ul>
          <li><code>https://your-domain.example.com/data-deletion-callback</code></li>
          <li><strong>Note:</strong> This callback must be served over HTTPS and be reachable by Facebook.</li>
        </ul>

        <h2>Contact</h2>
        <p>If you need help, email <strong>privacy@inboxplease.example</strong> and include the workspace or Page ID.</p>
      </article>
    </main>
  );
}
