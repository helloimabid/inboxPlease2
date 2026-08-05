export default function ReviewerInstructions() {
  return (
    <main className="page-content" style={{ paddingTop: 40 }}>
      <article className="panel" style={{ padding: 28, maxWidth: 900, margin: '0 auto' }}>
        <h1>Reviewer instructions — InboxPlease</h1>

        <h2>Website Login URL</h2>
        <pre>https://inboxplease2.helloimabid.com/signup</pre>

        <h2>Test account (for review only)</h2>
        <ul>
          <li><strong>Email:</strong> reviewer@inboxplease.com</li>
          <li><strong>Password:</strong> hozoborolo@inboxnow</li>
        </ul>

        <h2>Requested Meta permissions</h2>
        <p>pages_messaging, pages_show_list, pages_read_engagement, pages_manage_metadata</p>

        <h2>Reviewer steps</h2>
        <ol>
          <li>Open the website: <a href="https://inboxplease2.helloimabid.com/signup">https://inboxplease2.helloimabid.com/signup</a></li>
          <li>Log in using the test account above (no 2FA required).</li>
          <li>From the dashboard, click <em>Connect Facebook Page</em> and follow the Facebook Login flow.</li>
          <li>When asked, grant the requested permissions.</li>
          <li>Select the provided test Page (or create a test Page in the reviewer account) and confirm connection.</li>
          <li>Open the <em>Inbox</em> section in InboxPlease.</li>
          <li>Send a Messenger message to the connected Page from another Facebook account and verify the message appears in InboxPlease.</li>
          <li>Optionally, navigate to <em>Settings &gt; Integrations</em> to confirm Page metadata and tokens are visible to the app.</li>
        </ol>

        
        <h2>Contact</h2>
        <p>For any reviewer issues contact: <strong>me@helloimabid.com</strong></p>
      </article>
    </main>
  );
}
