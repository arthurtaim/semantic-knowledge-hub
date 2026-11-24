import { Link } from "react-router-dom";
import { EmptyState } from "../components/Feedback";

export function NotFoundPage() {
  return (
    <EmptyState title="Такой страницы нет" page>
      <p>Проверьте адрес или вернитесь на главную.</p>
      <Link to="/" className="button button--secondary">
        На главную
      </Link>
    </EmptyState>
  );
}
