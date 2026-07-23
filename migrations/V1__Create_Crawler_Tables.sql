-- V1__Create_Crawler_Tables.sql
-- Database migration script to initialize the Golem web crawler schema.

-- Create the page_contents table to hold raw and extracted crawl output
CREATE TABLE page_contents (
    url TEXT PRIMARY KEY,
    domain VARCHAR(255) NOT NULL,
    title VARCHAR(512),
    http_status INT,
    raw_html TEXT,
    extracted_text TEXT,
    saved_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index to optimize domain queries and listing
CREATE INDEX idx_page_contents_domain ON page_contents(domain);

-- Index to optimize Full-Text Search (FTS) on title and extracted text
CREATE INDEX idx_page_contents_fts ON page_contents 
USING gin(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(extracted_text, '')));

-- Create the link_filters table to exclude ads, spam, and social networks
CREATE TABLE link_filters (
    id SERIAL PRIMARY KEY,
    pattern TEXT NOT NULL UNIQUE,       -- E.g., 'facebook.com', 'doubleclick.net'
    filter_type VARCHAR(50) NOT NULL,   -- 'domain_blacklist', 'url_regex', 'keyword'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed initial default filters
INSERT INTO link_filters (pattern, filter_type) VALUES
('facebook.com', 'domain_blacklist'),
('twitter.com', 'domain_blacklist'),
('linkedin.com', 'domain_blacklist'),
('instagram.com', 'domain_blacklist'),
('tiktok.com', 'domain_blacklist'),
('youtube.com', 'domain_blacklist'),
('doubleclick.net', 'domain_blacklist'),
('google-analytics.com', 'domain_blacklist'),
('googlesyndication.com', 'domain_blacklist'),
('adnxs.com', 'domain_blacklist'),
('utm_', 'keyword'),
('.js', 'extension'),
('.css', 'extension'),
('.png', 'extension'),
('.jpg', 'extension'),
('.jpeg', 'extension'),
('.gif', 'extension'),
('.svg', 'extension'),
('.webp', 'extension'),
('.ico', 'extension'),
('.woff', 'extension'),
('.woff2', 'extension'),
('.ttf', 'extension'),
('.otf', 'extension'),
('.pdf', 'extension'),
('.zip', 'extension'),
('.tar', 'extension'),
('.gz', 'extension'),
('.mp3', 'extension'),
('.mp4', 'extension'),
('.wav', 'extension'),
('.avi', 'extension'),
('.mov', 'extension'),
('.xml', 'extension'),
('.json', 'extension'),
('.rss', 'extension'),
('.atom', 'extension');

