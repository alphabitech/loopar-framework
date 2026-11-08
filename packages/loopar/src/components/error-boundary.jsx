import { ErrorBoundary as Boundary} from "react-error-boundary";
import { __ } from "@global/i18n";

const formatComponentStack = (componentStack) => {
  const stackLines = componentStack.split("\n");
  const formattedStackLines = stackLines.map((line) => {
    const filePathIndex = line.indexOf(" (");
    if (filePathIndex > -1) {
      const cleanLine = line.substring(0, filePathIndex);
      return cleanLine.trim();
    }
    return line;
  });
  return formattedStackLines.join("\n");
}

function fallbackRender({ error, resetErrorBoundary }) {
  console.error(error);
  if(process.env.NODE_ENV === 'production') {
    return (
      <div
        className='flex justify-center items-center flex-col min-h-screen bg-background'
      >
        <h1 className='text-[20vw] m-0 text-red-500'>{__("Error")}</h1>
        <span className='text-2xl m-0'>{__("Something went wrong! Please try again later")}</span>
        <hr className='w-[50%] mt-10'/>
        <span className='text-4xl mt-4'>{__("Loopar")}</span>
      </div>
    );
  }
  return (
    <div className='bg-background p-4 rounded-md monospace pre-wrap'>
      <h4>{__("Browser error detected:")}</h4>
      <details style={{ whiteSpace: 'pre-wrap' }}>
        <p className='text-red-700'>{__("Error")}</p>
        <p className='text-red-500'>
        {error.message}
        </p>
        <br />
        <p className='text-red-400'>
        {formatComponentStack(error.stack)}
        </p>
      </details>
    </div>
  );
}

export function ErrorBoundary(props) {
  return (
    <Boundary
      fallbackRender={fallbackRender}
      onReset={(details) => {
        // Reset the state of your app so the error doesn't happen again
      }}
    >
      {props.children}
    </Boundary>
  )
}