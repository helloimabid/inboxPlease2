export default function PrivacyPolicy() {
  return (
    <main className="page-content" style={{ paddingTop: 40 }}>
      <article className="panel" style={{ padding: 28, maxWidth: 900, margin: '0 auto' }}>
        <h1>Privacy Policy</h1>
        <p>Effective date: August 5, 2026</p>

        <h2>Overview</h2>
        <p>
          InboxPlease helps Facebook Page owners manage Messenger conversations, catalogs, and orders. This
          Privacy Policy explains what data we collect, how we use it, how long we keep it, and how you can
          control or delete your data. This policy includes the details required for Facebook App Review.
        </p>

        <h2>Data we collect</h2>
        <ul>
          <li>Facebook Page and profile details (page name, page ID, profile name) required to connect Pages.</li>
          <li>Messenger conversation content and attachments when you enable inbox synchronization.</li>
          <li>Product catalog information you upload or create (titles, SKUs, descriptions, media).</li>
          <li>Order and transaction information created via the app (items, totals, customer name, address when provided).</li>
          <li>Usage and diagnostics data to operate and secure the service (timestamps, error logs, analytics).</li>
        </ul>

        <h2>How we use data</h2>
        <p>We use the data to:</p>
        <ul>
          <li>Provide the core InboxPlease service: reply to messages, match conversations to products, and track orders.</li>
          <li>Improve AI replies and product search (on-device or hosted models) with aggregated, non-identifying analytics.</li>
          <li>Send transactional messages related to orders and support when you request them.</li>
        </ul>

        <h2>What we send to Facebook</h2>
        <p>
          When you connect a Facebook Page we receive an access token and can fetch Page metadata and messages
          permitted by the Page token scope. We do not sell Page messages or profile data. Data shared with
          Facebook follows their platform policies and only includes the information necessary for the requested
          features (pages_messaging, pages_show_list, pages_read_engagement and other permissions requested during
          review).
        </p>

        <h2>Data retention and deletion</h2>
        <p>
          We retain conversation, catalog, and order data for as long as your workspace exists. You can request
          deletion of your workspace and related data by contacting us (see Contact below). When a deletion request
          is made we will stop processing and remove personal data within a reasonable timeframe and confirm when the
          deletion is complete.
        </p>

        <h2>User choices and controls</h2>
        <ul>
          <li>Disconnect a Facebook Page via the app settings — this revokes our access to that Page's messages.</li>
          <li>Request export or deletion of your workspace data by emailing the address below.</li>
          <li>Control notification and messaging preferences from your workspace settings.</li>
        </ul>

        <h2>Security</h2>
        <p>We implement reasonable administrative, physical, and technical safeguards to protect data. Access is limited
        to authorized personnel and systems. No service is perfectly secure — if you discover a vulnerability, contact us.</p>

        <h2>Business transfers</h2>
        <p>If we are involved in a merger, acquisition, or asset sale, your data may be transferred as part of that
        transaction. We will notify you and provide choices where required by law.</p>

        <h2>Contact</h2>
        <p>
          For questions, data requests, or to request deletion, contact: <strong>me@helloimabid.com</strong>
        </p>

        <h2>Facebook App Review information</h2>
        <p>
          This policy explains the exact data and permissions used for Facebook App Review: we request Page-level
          permissions to read messages and metadata needed to display inbox content and to send messages on your
          Page's behalf when you manually or automatically respond. We store tokens securely and provide a way to
          disconnect Pages and delete workspace data on request.
        </p>

        <p>Last updated: August 5, 2026</p>
      </article>
    </main>
  );
}
