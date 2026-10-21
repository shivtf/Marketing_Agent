from app import blog_posts


def test_tags_fit_devto():
    assert blog_posts.devto_tags(["CI/CD", "Jenkins", "ci-cd", "", "Docker", "K8s", "more"]) == [
        "cicd", "jenkins", "docker", "k8s"]
    assert blog_posts.devto_tags(None) == []


def test_the_heading_line_is_left_out_of_the_body():
    blog = {"id": "B1", "topic": "Jenkins tips", "content": "\n# Jenkins tips\n\nFirst line.\n## More", "keywords": []}
    assert blog_posts.article(blog) == ("Jenkins tips", "First line.\n## More", [])
    assert blog_posts.article({"id": "B2", "content": "No heading."}) == ("B2", "No heading.", [])


def test_posting_mode_defaults_to_off(monkeypatch):
    monkeypatch.delenv("BLOG_POSTING", raising=False)
    assert blog_posts.posting_mode() == "off"
    monkeypatch.setenv("BLOG_POSTING", " Live ")
    assert blog_posts.posting_mode() == "live"
    monkeypatch.setenv("BLOG_POSTING", "yes")
    assert blog_posts.posting_mode() == "off"


def test_the_headline_is_the_title_when_there_is_one():
    blog = {"id": "B1", "title": "The real title", "topic": "What it is about", "content": "Text."}
    assert blog_posts.article(blog)[0] == "The real title"
    assert blog_posts.article({**blog, "title": "  "})[0] == "What it is about"


def test_the_page_can_ask_for_the_mode(monkeypatch):
    from fastapi.testclient import TestClient

    from app.auth import current_user
    from app.main import app

    app.dependency_overrides[current_user] = lambda: {"sub": "u1"}
    try:
        monkeypatch.setenv("BLOG_POSTING", "draft")
        assert TestClient(app).get("/blog-posts/mode").json() == {"mode": "draft"}
    finally:
        app.dependency_overrides.clear()
