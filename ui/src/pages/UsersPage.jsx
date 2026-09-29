import {useCallback, useEffect, useMemo, useState} from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  DropdownMenu,
  Flex,
  Table,
  Text,
} from "@radix-ui/themes";
import {COLLECTION_API_BASE, USER_API_BASE, apiFetch} from "../lib/api";
import {ROLE_ADMIN, ROLE_EDITOR, useSession} from "../lib/session";
import PageHeading from "../components/PageHeading";
import PageReady from "../components/PageReady";

// A Drupal-style matrix: one column, one checkbox per role, every row showing
// the same three so the grid can be read down as well as across.
//
// "User" is the baseline — what holding no group means — so it is always
// checked and never writable. It is not a Cognito group and nothing is sent for
// it. Editor and Admin are independent rather than a ladder: a user can hold
// both, and Admin simply wins wherever they disagree.
const ROLE_COLUMNS = [
  {value: "user", label: "User", baseline: true},
  {value: ROLE_EDITOR, label: "Editor"},
  {value: ROLE_ADMIN, label: "Admin"},
];

function RoleMatrix({roles, saving, lockAdmin, onToggle}) {
  return (
    <Flex gap="4" wrap="wrap" className="role-matrix">
      {ROLE_COLUMNS.map((column) => {
        const checked = column.baseline || roles.includes(column.value);
        const locked = column.baseline || (column.value === ROLE_ADMIN && lockAdmin);
        const reason = column.baseline
          ? "Everyone who can sign in is a User"
          : locked
            ? "You cannot remove your own Admin role"
            : undefined;
        return (
          <Text as="label" size="2" key={column.value} className="role-matrix__option" title={reason}>
            <Checkbox
              size="1"
              checked={checked}
              disabled={saving || locked}
              onCheckedChange={() => onToggle(column.value)}
            />
            {column.label}
          </Text>
        );
      })}
    </Flex>
  );
}

// Grants are a set, so this is a menu of checkboxes rather than a select. Kept
// closed on select (Radix would close after one) so several can be toggled in
// one pass.
function GrantsMenu({granted, options, disabled, onToggle}) {
  const label = granted.length ? `${granted.length} collection${granted.length === 1 ? "" : "s"}` : "None";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button variant="soft" color="gray" size="1" disabled={disabled}>
          {label}
          <DropdownMenu.TriggerIcon />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1">
        {options.length === 0 && (
          <DropdownMenu.Item disabled>No collections yet</DropdownMenu.Item>
        )}
        {options.map((option) => (
          <DropdownMenu.CheckboxItem
            key={option.slug}
            checked={granted.includes(option.slug)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => onToggle(option.slug)}
          >
            {option.label}
          </DropdownMenu.CheckboxItem>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function UserRow({user, collections, saving, isSelf, onToggleRole, onSave}) {
  const isAdminRow = user.roles.includes(ROLE_ADMIN);
  return (
    <Table.Row className="manifest-list-row">
      <Table.RowHeaderCell>
        <Flex align="center" gap="2">
          <Text weight="bold">{user.email || user.username}</Text>
          {isSelf && (
            <Badge size="1" variant="soft" color="gray" radius="full">
              You
            </Badge>
          )}
        </Flex>
      </Table.RowHeaderCell>
      <Table.Cell>
        <Flex align="center" gap="2">
          <Text size="2" color={user.status === "CONFIRMED" ? "gray" : "orange"}>
            {user.status === "FORCE_CHANGE_PASSWORD" ? "Invited" : "Active"}
          </Text>
          {!user.enabled && (
            <Badge size="1" color="red" variant="soft" radius="full">
              Disabled
            </Badge>
          )}
        </Flex>
      </Table.Cell>
      <Table.Cell>
        <RoleMatrix
          roles={user.roles}
          saving={saving}
          // Only an admin reaches this page, so a self row is always an admin
          // row; the guard is written out anyway so it reads as the rule it is.
          lockAdmin={isSelf && isAdminRow}
          onToggle={(role) => onToggleRole(user, role)}
        />
      </Table.Cell>
      <Table.Cell>
        {isAdminRow ? (
          // An admin already reaches every collection, so a grant would be
          // decoration. Say why rather than showing a control that does nothing.
          <Text size="1" color="gray">
            All collections
          </Text>
        ) : (
          <GrantsMenu
            granted={user.collections}
            options={collections}
            disabled={saving}
            onToggle={(slug) =>
              onSave(user, {
                collections: user.collections.includes(slug)
                  ? user.collections.filter((entry) => entry !== slug)
                  : [...user.collections, slug].sort(),
              })
            }
          />
        )}
      </Table.Cell>
    </Table.Row>
  );
}

export default function UsersPage() {
  const session = useSession();
  const isAdmin = session.role === ROLE_ADMIN;

  const [users, setUsers] = useState([]);
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState(null);
  const [savingUser, setSavingUser] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [userData, collectionData] = await Promise.all([
          apiFetch(USER_API_BASE, {errorMessage: "Unable to load users"}),
          apiFetch(COLLECTION_API_BASE, {errorMessage: "Unable to load collections"}),
        ]);
        if (cancelled) return;
        setUsers(Array.isArray(userData.users) ? userData.users : []);
        setCollections(Array.isArray(collectionData.collections) ? collectionData.collections : []);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const handleSave = useCallback(
    async (user, changes) => {
      setSavingUser(user.username);
      setError(null);
      setNotice(null);
      // The API replaces the whole assignment, so send both halves even when
      // only one changed.
      const payload = {
        roles: changes.roles !== undefined ? changes.roles : user.roles,
        collections: changes.collections !== undefined ? changes.collections : user.collections,
      };
      try {
        const data = await apiFetch(`${USER_API_BASE}/${encodeURIComponent(user.username)}`, {
          method: "PUT",
          body: payload,
          errorMessage: "Unable to update user",
        });
        setUsers((prev) =>
          prev.map((entry) =>
            entry.username === user.username
              ? {...entry, roles: data.roles ?? [], collections: data.collections ?? []}
              : entry,
          ),
        );
        setNotice(
          `Saved. ${user.email || user.username} picks this up at their next sign-in, or within the hour when their token refreshes.`,
        );
      } catch (err) {
        setError(err.message);
      } finally {
        setSavingUser(null);
      }
    },
    [],
  );

  const handleToggleRole = useCallback(
    (user, role) => {
      const next = user.roles.includes(role)
        ? user.roles.filter((entry) => entry !== role)
        : [...user.roles, role];
      return handleSave(user, {roles: next});
    },
    [handleSave],
  );

  const sortedCollections = useMemo(
    () => [...collections].sort((a, b) => a.label.localeCompare(b.label)),
    [collections],
  );

  if (!isAdmin) {
    return (
      <PageReady>
        <Flex direction="column" gap="5">
          <PageHeading>Users</PageHeading>
          <Card size="3" className="panel">
            <Box className="panel-body">
              <Callout.Root color="gray" size="1">
                <Callout.Text>Only an administrator can manage users.</Callout.Text>
              </Callout.Root>
            </Box>
          </Card>
        </Flex>
      </PageReady>
    );
  }

  return (
    <PageReady ready={!loading}>
      <Flex direction="column" gap="5">
        <PageHeading>Users</PageHeading>
        <Card size="3" className="panel">
          <Box className="panel-body">
            {error && (
              <Callout.Root color="red" size="1" mb="3">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            {notice && !error && (
              <Callout.Root color="green" size="1" mb="3">
                <Callout.Text>{notice}</Callout.Text>
              </Callout.Root>
            )}
            {loading ? (
              <Text as="p" size="2" color="gray">
                Loading users…
              </Text>
            ) : (
              <>
                {/* Ghost, like the works table on a collection's page. */}
                <Table.Root variant="ghost" className="manifest-list">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>User</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Collections</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {users.map((user) => (
                      <UserRow
                        key={user.username}
                        user={user}
                        collections={sortedCollections}
                        saving={savingUser === user.username}
                        isSelf={user.email === session.username}
                        onToggleRole={handleToggleRole}
                        onSave={handleSave}
                      />
                    ))}
                  </Table.Body>
                </Table.Root>
                <Text as="p" size="1" color="gray" mt="3">
                  Accounts are created in Cognito, not here — this pool is invite-only. A user with no
                  role can sign in and browse, but cannot change anything.
                </Text>
              </>
            )}
          </Box>
        </Card>
      </Flex>
    </PageReady>
  );
}
