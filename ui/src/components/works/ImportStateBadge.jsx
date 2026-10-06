import {Badge, Flex, Progress, Text} from "@radix-ui/themes";

// Where one work is in a running collection import, drawn the way a canvas's
// state is on a work's own page: waiting, then an unsized bar while it is being
// copied, then a result. `state` is one of the names in shared/importProgress.js.
export default function ImportStateBadge({state}) {
  switch (state) {
    case "importing":
      return (
        <Flex direction="column" gap="1" className="import-state">
          <Text size="1" color="indigo">
            Importing…
          </Text>
          <Progress size="1" duration="60s" />
        </Flex>
      );
    case "ok":
      return (
        <Badge size="1" variant="soft" radius="full" color="green">
          Imported
        </Badge>
      );
    case "partial":
      return (
        <Badge size="1" variant="soft" radius="full" color="orange">
          Some images missing
        </Badge>
      );
    case "failed":
      return (
        <Badge size="1" variant="soft" radius="full" color="red">
          Failed
        </Badge>
      );
    case "deferred":
      return (
        <Badge size="1" variant="soft" radius="full" color="orange">
          Not reached
        </Badge>
      );
    default:
      return (
        <Text size="1" color="gray" className="import-state">
          Waiting to import…
        </Text>
      );
  }
}
